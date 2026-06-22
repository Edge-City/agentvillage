import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "audit_token_usage.py"
SPEC = importlib.util.spec_from_file_location("audit_token_usage", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules["audit_token_usage"] = audit
SPEC.loader.exec_module(audit)


NOW = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)


class TokenUsageAuditTests(unittest.TestCase):
    def write_json(self, path: Path, data: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_cron_attribution_prefers_safe_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_json(
                root / "cron/jobs.json",
                {
                    "jobs": [
                        {"id": "job-safe-id", "name": "Edge - digest prepare", "lastRunAt": "2026-06-22T11:00:00Z"},
                        {"id": "other", "name": "Other cron", "lastRunAt": "2026-06-22T11:00:00Z"},
                    ]
                },
            )
            cron_public, cron_index = audit.load_crons(root, NOW.replace(hour=0), NOW)

            attribution = audit.attribute_cron(
                {"createdAt": "2026-06-22T11:05:00Z", "metadata": {"jobId": "job-safe-id"}},
                audit.parse_time("2026-06-22T11:05:00Z"),
                cron_index,
            )

        self.assertEqual(cron_public["totalJobs"], 2)
        self.assertEqual(attribution["cronName"], "Edge - digest prepare")
        self.assertEqual(attribution["method"], "metadata_id")
        self.assertEqual(attribution["confidence"], "high")
        self.assertEqual(attribution["ambiguityCount"], 0)

    def test_cron_attribution_marks_ambiguous_timestamp_matches_low_confidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_json(
                root / "cron/jobs.json",
                {
                    "jobs": [
                        {"id": "a", "name": "Edge - digest prepare", "lastRunAt": "2026-06-22T11:00:00Z"},
                        {"id": "b", "name": "Edge - daily digest", "lastRunAt": "2026-06-22T11:03:00Z"},
                    ]
                },
            )
            _, cron_index = audit.load_crons(root, NOW.replace(hour=0), NOW)

            attribution = audit.attribute_cron(
                {"createdAt": "2026-06-22T11:04:00Z"},
                audit.parse_time("2026-06-22T11:04:00Z"),
                cron_index,
            )

        self.assertEqual(attribution["method"], "time_window_nearest_ambiguous")
        self.assertEqual(attribution["confidence"], "low")
        self.assertEqual(attribution["ambiguityCount"], 1)

    def test_decision_wakes_for_actionable_known_cron_and_cools_down(self) -> None:
        result = {
            "totals": {"totalTokens": 160_000},
            "bySource": [{"label": "cron", "totalTokens": 160_000}],
            "byCron": [{"label": "Edge - digest prepare", "totalTokens": 120_000}],
            "topSessions": [
                {
                    "sessionRef": "session_001",
                    "totalTokens": 120_000,
                    "cronName": "Edge - digest prepare",
                    "cronAttribution": {"method": "metadata_name", "confidence": "high", "ambiguityCount": 0},
                }
            ],
            "budgetSignals": [],
        }

        wake, driver = audit.decide_alert(result, {}, NOW, cooldown_hours=72, total_threshold=100_000)

        self.assertTrue(wake)
        self.assertIsNotNone(driver)
        self.assertEqual(driver["type"], "single_cron")
        state = {"lastAlerts": {driver["driverKey"]: NOW.isoformat()}}
        wake_again, cooled = audit.decide_alert(result, state, NOW, cooldown_hours=72, total_threshold=100_000)
        self.assertFalse(wake_again)
        self.assertEqual(cooled["suppressedByCooldown"], True)

    def test_cli_no_alert_prints_quiet_contract_and_sanitizes_session_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / "sessions.json"
            current = datetime.now(timezone.utc).isoformat()
            self.write_json(
                sessions,
                {
                    "sessions": [
                        {
                            "id": "raw-secret-session-id",
                            "createdAt": current,
                            "source": "chat",
                            "model": "gpt-test",
                            "usage": {"totalTokens": 1_000},
                        }
                    ]
                },
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(root),
                    "--dashboard-sessions-file",
                    str(sessions),
                ],
                text=True,
                capture_output=True,
                check=True,
            )

        self.assertEqual(json.loads(completed.stdout.strip().splitlines()[-1]), {"wakeAgent": False})
        self.assertNotIn("raw-secret-session-id", completed.stdout)

    def test_cli_alert_shape_uses_sanitized_facts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = datetime.now(timezone.utc).isoformat()
            self.write_json(
                root / "cron/jobs.json",
                {"jobs": [{"id": "job1", "name": "Edge - digest prepare", "lastRunAt": current}]},
            )
            sessions = root / "sessions.json"
            self.write_json(
                sessions,
                {
                    "sessions": [
                        {
                            "id": "raw-secret-session-id",
                            "createdAt": current,
                            "source": "cron",
                            "model": "gpt-test",
                            "metadata": {"jobId": "job1"},
                            "usage": {"totalTokens": 180_000},
                            "toolCalls": 7,
                        }
                    ]
                },
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(root),
                    "--dashboard-sessions-file",
                    str(sessions),
                ],
                text=True,
                capture_output=True,
                check=True,
            )

        last = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(last["wakeAgent"])
        self.assertEqual(last["driver"]["type"], "single_cron")
        self.assertIn("Edge - digest prepare", completed.stdout)
        self.assertNotIn("raw-secret-session-id", completed.stdout)


if __name__ == "__main__":
    unittest.main()
