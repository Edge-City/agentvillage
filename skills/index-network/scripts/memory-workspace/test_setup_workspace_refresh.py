#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

import setup_workspace


def completed_refresh_calls() -> list[subprocess.CompletedProcess[str]]:
    return [
        subprocess.CompletedProcess(["enzyme", "status"], 0, "initialized", ""),
        subprocess.CompletedProcess(["enzyme", "refresh"], 0, "", ""),
    ]


class SetupWorkspaceRefreshTest(unittest.TestCase):
    def test_refresh_skips_without_provider_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict(setup_workspace.os.environ, {}, clear=True):
                result = setup_workspace.refresh_enzyme_index(root, "enzyme", "openrouter", 0)

            self.assertEqual(result["status"], "skipped")
            self.assertEqual(result["reason"], "missing-provider-env")
            self.assertEqual(result["missingEnv"], ["OPENROUTER_API_KEY"])
            self.assertIn("OPENROUTER_API_KEY", (root / "memory" / "enzyme-refresh-status.json").read_text(encoding="utf-8"))
            self.assertNotIn("secret", (root / "memory" / "enzyme-refresh-status.json").read_text(encoding="utf-8"))

    def test_refresh_skips_without_memory_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enzyme = root / "enzyme"
            enzyme.write_text("#!/bin/sh\n", encoding="utf-8")

            with patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True):
                result = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(result["status"], "skipped")
            self.assertEqual(result["reason"], "no-memory-input")
            self.assertEqual(result["inputs"]["count"], 0)

    def test_refresh_initializes_when_status_indicates_missing_index_then_refreshes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enzyme = root / "enzyme"
            enzyme.write_text("#!/bin/sh\n", encoding="utf-8")
            forum = root / "memory" / "forum" / "2026-06-17.md"
            forum.parent.mkdir(parents=True)
            forum.write_text("grounded note", encoding="utf-8")

            completed = [
                subprocess.CompletedProcess(["enzyme", "status"], 1, "", "not initialized"),
                subprocess.CompletedProcess(["enzyme", "init"], 0, "", ""),
                subprocess.CompletedProcess(["enzyme", "refresh"], 0, "", ""),
            ]

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run", side_effect=completed) as run,
            ):
                result = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(result["status"], "success")
            self.assertEqual([action["action"] for action in result["actions"]], ["status", "init", "refresh"])
            self.assertTrue(result["actions"][1]["useEnvLlm"])
            self.assertTrue(result["actions"][2]["useEnvLlm"])
            self.assertEqual(run.call_args_list[1][0][0][-1], "--use-env-llm")
            self.assertEqual(run.call_args_list[2][0][0][-1], "--use-env-llm")
            status_text = (root / "memory" / "enzyme-refresh-status.json").read_text(encoding="utf-8")
            self.assertIn("lastSuccess", status_text)
            self.assertIn("sourceFingerprint", status_text)
            self.assertNotIn("secret", status_text)

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run") as second_run,
            ):
                second = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(second["status"], "skipped")
            self.assertEqual(second["reason"], "no-source-change")
            second_run.assert_not_called()

    def test_refresh_detects_new_file_with_older_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enzyme = root / "enzyme"
            enzyme.write_text("#!/bin/sh\n", encoding="utf-8")
            forum = root / "memory" / "forum" / "2026-06-17.md"
            forum.parent.mkdir(parents=True)
            forum.write_text("grounded note", encoding="utf-8")
            os.utime(forum, (2000, 2000))

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run", side_effect=completed_refresh_calls()),
            ):
                first = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(first["status"], "success")
            backfill = root / "memory" / "forum" / "2026-06-16.md"
            backfill.write_text("older backfill", encoding="utf-8")
            os.utime(backfill, (1000, 1000))

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run", side_effect=completed_refresh_calls()) as run,
            ):
                second = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(second["status"], "success")
            self.assertEqual(second["inputs"]["count"], 2)
            self.assertEqual(run.call_count, 2)

    def test_refresh_detects_count_change_without_newer_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enzyme = root / "enzyme"
            enzyme.write_text("#!/bin/sh\n", encoding="utf-8")
            forum = root / "memory" / "forum" / "2026-06-17.md"
            irl = root / "memory" / "irl" / "2026-06-17.md"
            forum.parent.mkdir(parents=True)
            irl.parent.mkdir(parents=True)
            forum.write_text("forum note", encoding="utf-8")
            irl.write_text("irl note", encoding="utf-8")
            os.utime(forum, (2000, 2000))
            os.utime(irl, (1000, 1000))

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run", side_effect=completed_refresh_calls()),
            ):
                first = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(first["status"], "success")
            irl.unlink()

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run", side_effect=completed_refresh_calls()) as run,
            ):
                second = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(second["status"], "success")
            self.assertEqual(second["inputs"]["count"], 1)
            self.assertEqual(second["inputs"]["newestMtime"], first["inputs"]["newestMtime"])
            self.assertEqual(run.call_count, 2)

    def test_direct_setup_env_helpers_match_installer_opt_in(self) -> None:
        with patch.dict(setup_workspace.os.environ, {}, clear=True):
            self.assertFalse(setup_workspace.should_install_enzyme_refresh_cron(False, None))
            self.assertTrue(setup_workspace.should_install_enzyme_refresh_cron(False, "0 3 * * *"))
            self.assertEqual(setup_workspace.resolve_enzyme_refresh_cron("0 3 * * *"), "0 3 * * *")

        with patch.dict(setup_workspace.os.environ, {"ENZYME_REFRESH_CRON": "15 3 * * *"}, clear=True):
            self.assertTrue(setup_workspace.should_install_enzyme_refresh_cron(False, None))
            self.assertEqual(setup_workspace.resolve_enzyme_refresh_cron(None), "15 3 * * *")

        with patch.dict(setup_workspace.os.environ, {"AGENTVILLAGE_ENZYME_REFRESH_CRON": "yes"}, clear=True):
            self.assertTrue(setup_workspace.should_install_enzyme_refresh_cron(False, None))

        with patch.dict(setup_workspace.os.environ, {"ENZYME_REFRESH_CRON": "garbage"}, clear=True):
            self.assertTrue(setup_workspace.should_install_enzyme_refresh_cron(False, None))
            self.assertEqual(setup_workspace.resolve_enzyme_refresh_cron(None), "30 2 * * *")


if __name__ == "__main__":
    unittest.main()
