#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from setup_workspace import ENZYME_BLOCK_BEGIN, ENZYME_BLOCK_END, install_enzyme_config, managed_enzyme_block, migrate_legacy_vault


class SetupWorkspaceConfigTest(unittest.TestCase):
    def test_install_removes_unmanaged_duplicate_target_table(self) -> None:
        vault = Path("/opt/data/memory")
        legacy = Path("/opt/data/agent-memory-vault")
        unrelated = Path("/opt/data/other-vault")
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text(
                "\n".join(
                    [
                        '# operator config',
                        '[vaults."/opt/data/memory"]',
                        'entities = [{ "folder:old-current" = { profile = "old" } }]',
                        "",
                        '[vaults."/opt/data/agent-memory-vault"]',
                        'entities = [{ "folder:old-legacy" = { profile = "old" } }]',
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

            install_enzyme_config(vault, config_path, stale_vaults=[legacy])
            first = config_path.read_text(encoding="utf-8")
            install_enzyme_config(vault, config_path, stale_vaults=[legacy])
            second = config_path.read_text(encoding="utf-8")

        self.assertEqual(first, second)
        self.assertEqual(second.count(f'[vaults."{vault}"]'), 1)
        self.assertNotIn(f'[vaults."{legacy}"]', second)
        self.assertEqual(second.count(ENZYME_BLOCK_BEGIN), 1)
        self.assertEqual(second.count(ENZYME_BLOCK_END), 1)
        self.assertIn(f'[vaults."{unrelated}"]', second)
        self.assertIn('folder:other', second)
        self.assertNotIn('folder:old-current', second)
        self.assertNotIn('folder:old-legacy', second)

    def test_migrates_legacy_vault_content_to_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old_forum = root / "agent-memory-vault" / "forum" / "2026-06-16.md"
            old_session = root / "agent-memory-vault" / "hermes" / "sessions" / "2026-06-16" / "s.md"
            old_forum.parent.mkdir(parents=True)
            old_session.parent.mkdir(parents=True)
            old_forum.write_text("legacy forum", encoding="utf-8")
            old_session.write_text("legacy session", encoding="utf-8")

            result = migrate_legacy_vault(root)
            second = migrate_legacy_vault(root)

            self.assertTrue(result["migrated"])
            self.assertEqual((root / "memory" / "forum" / "2026-06-16.md").read_text(encoding="utf-8"), "legacy forum")
            self.assertEqual((root / "memory" / "hermes" / "sessions" / "2026-06-16" / "s.md").read_text(encoding="utf-8"), "legacy session")
            self.assertFalse((root / "agent-memory-vault").exists())
            self.assertFalse(second["migrated"])


if __name__ == "__main__":
    unittest.main()
