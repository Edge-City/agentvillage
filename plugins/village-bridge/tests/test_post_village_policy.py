"""Cross-language operator-policy truth table; synthetic local files only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('av_test_post_village', ROOT / 'plugins/village-bridge/_post_village_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
FIXTURES = json.loads((ROOT / 'scripts/tests/fixtures/post-village-policy.json').read_text())

class PolicyTest(unittest.TestCase):
    def test_shared_truth_table_all_nine_keys(self):
        self.assertEqual(policy.KEYS, set(FIXTURES['keys']))
        for fixture in FIXTURES['cases']:
            with self.subTest(name=fixture['name']), tempfile.TemporaryDirectory() as directory:
                home = Path(directory); (home / 'av-events').mkdir()
                (home / 'av-events/post-village-policy.json').write_text(fixture['raw'])
                self.assertEqual(policy.read_policy(home)[0], 'ok' if fixture['valid'] else 'invalid')
                for key in FIXTURES['keys']:
                    self.assertEqual(policy.allowed(home, key, policy.INDIA_END), key in fixture['enabled'])

    def test_cutoff_missing_symlink_and_invalid_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            for key in FIXTURES['keys']:
                self.assertTrue(policy.allowed(home, key, policy.INDIA_END - .001))
                self.assertFalse(policy.allowed(home, key, policy.INDIA_END))
                self.assertFalse(policy.allowed(home, key, policy.INDIA_END + .001))
            (home / 'av-events').mkdir(); other = home / 'other'
            other.write_text('{"version":1,"enabled":["daily_digest"]}')
            (home / 'av-events/post-village-policy.json').symlink_to(other)
            self.assertFalse(policy.allowed(home, 'daily_digest'))
            self.assertFalse(policy.allowed(home, 'daily_digest', float('nan')))

    def test_admin_hold_blocks_an_explicit_allow_without_mutating_files(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); (home / 'av-events').mkdir(); (home / 'cron').mkdir()
            raw = '{"version":1,"enabled":["zzz_pairs"]}'
            target = home / 'av-events/post-village-policy.json'; target.write_text(raw)
            (home / 'cron/jobs.json').write_text(json.dumps({'jobs': [{'id': 'aaaaaaaaaaaa', 'name': 'Edge — zzz pairs', 'enabled': True}]}))
            (home / 'av-events/job-holds.json').write_text(json.dumps({'holds': {'aaaaaaaaaaaa': 'paused'}, 'by': {'aaaaaaaaaaaa': 'admin'}}))
            self.assertTrue(policy.allowed(home, 'zzz_pairs'))
            self.assertFalse(policy.runtime_allowed(home, 'zzz_pairs'))
            self.assertEqual(target.read_text(), raw)

    def test_autonomy_gate_uses_exact_canonical_reader_and_revocation_is_effective(self):
        import hashlib
        import shutil
        source = ROOT / 'skills/zzzbot/scripts/zzz_autonomy_runner.py'
        spec = importlib.util.spec_from_file_location('av_test_autonomy_policy', source)
        runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
        canonical = ROOT / 'plugins/village-bridge/_post_village_policy.py'
        self.assertEqual(runner.POLICY_READER_SHA256, hashlib.sha256(canonical.read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); (home / 'av-events').mkdir()
            installed = home / 'plugins/village-bridge/_post_village_policy.py'; installed.parent.mkdir(parents=True)
            shutil.copyfile(canonical, installed)
            target = home / 'av-events/post-village-policy.json'
            self.assertFalse(runner._post_village_allowed(home))
            from unittest.mock import patch
            with patch.object(runner, '_activity') as activity, patch.object(runner, '_model_route') as model:
                runner.run(home)
                activity.assert_not_called(); model.assert_not_called()
            target.write_text('{"version":1,"enabled":["zzz_event_autonomy"]}')
            self.assertTrue(runner._post_village_allowed(home))
            target.unlink(); self.assertFalse(runner._post_village_allowed(home))
            target.write_text('{"version":1,"enabled":["zzz_event_autonomy"]}')
            installed.write_text('raise RuntimeError("never execute mismatched helper")')
            self.assertFalse(runner._post_village_allowed(home))
