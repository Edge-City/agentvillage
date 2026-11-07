"""No real gathering asks: all outbound writes are stubbed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('mochi_test_fixture', Path(__file__).with_name('test_forkicks.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
from village_bridge import _mochi as mochi


class MochiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.details = dict(asked_by_person=True, gathering='Song circle', date='2026-10-27', time='17:00', place='Riva public lawn', headcount=8, contact='@synthetic', note='No private details')
        self.transport = Mock(return_value={'receipt': 'stub-only'})
        self.ap = Mock()
        self.ap.propose.side_effect = lambda cls, key, summary, held: NS(ok=True, doc={'task': 'propose:' + 'a' * 32, 'decision': 'requested', 'payload_hash': hashlib.sha256(held.encode()).hexdigest()})
        self.ap.wait.return_value = NS(exit_code=0, status='granted')
        self.ap.start.return_value = NS(ok=True, doc={'authorization': 'grant'})

    def prepare(self):
        return mochi.execute({'operation': 'prepare', 'details': self.details}, self.home, 'owner', self.ap, self.transport)

    def confirm(self, draft, owner='owner'):
        return mochi.execute({'operation': 'confirm', 'draftId': draft['draftId']}, self.home, owner, self.ap, self.transport)

    def test_prepare_never_sends_and_private_file(self):
        draft = self.prepare()
        self.transport.assert_not_called()
        self.ap.propose.assert_not_called()
        self.assertEqual(mochi.draft_path(self.home, draft['draftId']).stat().st_mode & 0o777, 0o600)

    def test_waiting_denied_expired_never_send(self):
        for status in ('pending', 'denied', 'expired', 'withdrawn'):
            self.ap.wait.return_value = NS(exit_code=6, status=status)
            self.assertEqual(self.confirm(self.prepare())['error'], 'approval_required')
        self.transport.assert_not_called()
        self.ap.start.assert_not_called()

    def test_autonomy_and_wrong_hash_refuse(self):
        for decision, digest in [('autonomous', None), ('requested', 'bad')]:
            self.ap.propose.side_effect = lambda cls, key, summary, held: NS(ok=True, doc={'task': 'propose:' + 'a'*32, 'decision': decision, 'payload_hash': digest or hashlib.sha256(held.encode()).hexdigest()})
            with self.assertRaisesRegex(ValueError, 'approval_refused'):
                self.confirm(self.prepare())
        self.transport.assert_not_called()

    def test_exact_card_fields_and_same_key_retry(self):
        draft = self.prepare()
        self.confirm(draft)
        self.confirm(draft)
        sent = self.transport.call_args.args[1]
        self.assertEqual(sent, {**self.details, 'request_key': draft['draftId']})
        card = json.loads(self.ap.propose.call_args.args[3])
        self.assertEqual(card, {k: v if isinstance(v, str) else mochi.canonical(v) for k,v in sent.items()})
        self.assertEqual(self.transport.call_args_list[0], self.transport.call_args_list[1])
        self.assertEqual(self.ap.start.call_args.args[2], mochi.canonical(card))

    def test_wrong_owner_or_injected_fields_refuse(self):
        with self.assertRaisesRegex(ValueError, 'private_owner'):
            self.confirm(self.prepare(), 'other')
        for extra in ({'email': 'secret'}, {'request_key': 'forged'}, {'asked_by_person': False}, {'headcount': True}, {'note': 'https://bad.example'}):
            with self.assertRaises(ValueError):
                mochi.validate({**self.details, **extra})
        self.transport.assert_not_called()

    def test_read_allowlist_no_approval(self):
        for name in mochi.READS:
            mochi.execute({'operation': name}, self.home, None, self.ap, self.transport)
        self.assertEqual(self.transport.call_count, 3)
        self.ap.propose.assert_not_called()

    def test_start_requires_human_grant(self):
        self.ap.start.return_value = NS(ok=True, doc={'authorization': 'policy'})
        with self.assertRaisesRegex(ValueError, 'approval_not_started'):
            self.confirm(self.prepare())
        self.transport.assert_not_called()

    def test_redirects_and_extra_read_arguments_refuse(self):
        with self.assertRaisesRegex(ValueError, 'redirect_refused'):
            mochi.NoRedirect().redirect_request(None, None, None, None)
        with self.assertRaisesRegex(ValueError, 'invalid_arguments'):
            mochi.execute({'operation': 'mochi_about', 'contact': 'secret'}, self.home, None, self.ap, self.transport)
        self.transport.assert_not_called()

    def test_executed_retry_reuses_exact_idempotent_request(self):
        draft = self.prepare()
        self.confirm(draft)
        first = self.transport.call_args
        self.ap.propose.side_effect = lambda cls, key, summary, held: NS(ok=True, doc={
            'task': 'propose:' + 'a' * 32, 'decision': 'requested', 'state': 'executed',
            'payload_hash': hashlib.sha256(held.encode()).hexdigest()})
        self.ap.wait.reset_mock()
        self.ap.start.reset_mock()
        self.confirm(draft)
        self.assertEqual(first, self.transport.call_args)
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
