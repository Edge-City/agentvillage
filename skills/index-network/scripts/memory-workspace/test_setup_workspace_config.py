#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from setup_workspace import ENZYME_BLOCK_BEGIN, ENZYME_BLOCK_END, install_enzyme_config, managed_enzyme_block


class SetupWorkspaceConfigTest(unittest.TestCase):
    def test_install_removes_unmanaged_duplicate_target_table(self) -> None:
        vault = Path("/opt/data/agent-memory-vault")
        unrelated = Path("/opt/data/other-vault")
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(
                "\n".join(
                    [
                        '# operator config',
                        '[vaults."/opt/data/agent-memory-vault"]',
                        'entities = [{ "folder:old" = { profile = "old" } }]',
                        'excluded_folders = ["old"]',
                        "",
                        managed_enzyme_block(vault).rstrip(),
                        "",
                        f'[vaults."{unrelated}"]',
                        'entities = [{ "folder:other" = { profile = "resonance_trace" } }]',
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            install_enzyme_config(vault, config_path)
            first = config_path.read_text(encoding="utf-8")
            install_enzyme_config(vault, config_path)
            second = config_path.read_text(encoding="utf-8")

        self.assertEqual(first, second)
        self.assertEqual(second.count(f'[vaults."{vault}"]'), 1)
        self.assertEqual(second.count(ENZYME_BLOCK_BEGIN), 1)
        self.assertEqual(second.count(ENZYME_BLOCK_END), 1)
        self.assertIn(f'[vaults."{unrelated}"]', second)
        self.assertIn('folder:other', second)
        self.assertNotIn('folder:old', second)


if __name__ == "__main__":
    unittest.main()
