#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from setup_workspace import write_enzyme_env


class SetupWorkspaceEnvTest(unittest.TestCase):
    def test_enzyme_env_adds_local_bin_paths_without_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path = write_enzyme_env(root, "openrouter")
            text = env_path.read_text(encoding="utf-8")

        self.assertIn(f"{root}/.local/bin", text)
        self.assertIn("${HERMES_HOME:-", text)
        self.assertIn("$HOME/.local/bin", text)
        self.assertIn("/opt/data/.local/bin", text)
        self.assertIn('export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:', text)
        self.assertNotIn("sk-", text)
        self.assertNotIn("eos_live_", text)


if __name__ == "__main__":
    unittest.main()
