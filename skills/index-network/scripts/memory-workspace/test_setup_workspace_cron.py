#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import subprocess

import setup_workspace


class SetupWorkspaceCronTest(unittest.TestCase):
    def test_cron_prompt_keeps_enzyme_refresh_operator_gated(self) -> None:
        prompt = setup_workspace.cron_prompt()

        self.assertIn("workspace_loop.py --prepare", prompt)
        self.assertIn("Do not run `enzyme refresh` from this heartbeat", prompt)
        self.assertIn("provider-gated refresh path", prompt)

    def test_install_cron_removes_stale_same_name_even_when_valid_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "skills" / "index-network" / "scripts" / "memory-workspace" / "cron_prepare.py"
            script.parent.mkdir(parents=True)
            script.write_text("# test\n", encoding="utf-8")

            calls: list[tuple[str, str | None]] = []

            def fake_remove(name: str, hermes_bin: str, script_name: str) -> list[str]:
                calls.append(("remove", script_name))
                return ["stale-1"]

            def fake_exists(name: str, hermes_bin: str, script_name: str | None = None) -> bool:
                calls.append(("exists", script_name))
                return True

            with (
                patch.object(setup_workspace, "remove_stale_crons", side_effect=fake_remove),
                patch.object(setup_workspace, "cron_exists", side_effect=fake_exists),
                patch.object(setup_workspace.subprocess, "run") as run,
            ):
                result = setup_workspace.install_cron(root, "0 2 * * *", "Hermes agent memory heartbeat", "hermes")

            self.assertEqual(result["installed"], False)
            self.assertEqual(result["reason"], "already-exists")
            self.assertEqual(result["removedStale"], ["stale-1"])
            self.assertEqual([call[0] for call in calls], ["remove", "exists"])
            self.assertEqual(calls[0][1], result["script"])
            self.assertEqual(calls[1][1], result["script"])
            run.assert_not_called()

    def test_refresh_cron_prompt_is_non_delivering_noop(self) -> None:
        prompt = setup_workspace.refresh_cron_prompt()

        self.assertIn("attached script already handled", prompt)
        self.assertIn("Do not call Telegram", prompt)
        self.assertIn("Return `[SILENT]`", prompt)

    def test_install_refresh_cron_uses_setup_wrapper_without_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "skills" / "index-network" / "scripts" / "memory-workspace" / "setup_workspace.py"
            script.parent.mkdir(parents=True)
            script.write_text("# test\n", encoding="utf-8")

            with (
                patch.object(setup_workspace, "remove_stale_crons", return_value=[]),
                patch.object(setup_workspace, "cron_exists", side_effect=[False, True]),
                patch.object(setup_workspace.subprocess, "run", return_value=subprocess.CompletedProcess(["hermes"], 0, "", "")) as run,
            ):
                result = setup_workspace.install_refresh_cron(root, "30 2 * * *", "Hermes agent memory index refresh", "hermes", "auto", 0)

            wrapper = root / ".hermes" / "scripts" / result["script"]
            text = wrapper.read_text(encoding="utf-8")
            self.assertIn("--refresh-enzyme-index", text)
            self.assertNotIn("--use-env-llm", text)
            args = run.call_args[0][0]
            self.assertIn("--script", args)
            self.assertNotIn("--deliver", args)


if __name__ == "__main__":
    unittest.main()
