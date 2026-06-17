#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import setup_workspace


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
            self.assertNotIn("secret", status_text)

            with (
                patch.dict(setup_workspace.os.environ, {"OPENROUTER_API_KEY": "secret"}, clear=True),
                patch.object(setup_workspace.subprocess, "run") as second_run,
            ):
                second = setup_workspace.refresh_enzyme_index(root, str(enzyme), "openrouter", 0)

            self.assertEqual(second["status"], "skipped")
            self.assertEqual(second["reason"], "no-source-change")
            second_run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
