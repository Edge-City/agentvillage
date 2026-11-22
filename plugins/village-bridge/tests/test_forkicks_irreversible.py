"""For Kicks proposes with `--irreversible` (lead RULED L60017; approval.md APRV-537): a card under every setting on a
core that knows the flag, and exactly today's behaviour on core 0.4.8 (the one retry without it, in av-events'
client). Driven here through the REAL av-events client (`_approval`, loaded under a private name) behind its
`_transport` seam, so the retry is the shipped one. Also review-b #628 N2 (a replayed prepare of a started draft never
says a new card was sent) and N3 (a known task started without its own grant never says "approve it on its card")."""
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    _spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = fixture
    _spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
fk = sys.modules['village_bridge._forkicks']
grant = sys.modules['village_bridge._forkicks_grant']

# av-events' real client under a private package name (never `hermes_plugins.av_events`, which av-events' own tests load).
_AV = 'village_bridge_test_av_events'
if _AV not in sys.modules:
    _pkg = types.ModuleType(_AV)
    _pkg.__path__ = [str(Path(__file__).resolve().parents[2] / 'av-events')]
    sys.modules[_AV] = _pkg
client = importlib.import_module(_AV + '._approval')

TASK = 'propose:' + 'c' * 32
SERVE_403_0_4_8 = ('{"error":{"code":"serve-flag-not-permitted","message":"--irreversible is not accepted on `approval '
                   'propose` from the agent credential, which takes --class, --json, --key, --payload-json, --summary on '
                   'this verb and nothing else. A flag added to it later is refused until somebody decides a harness under '
                   'oversight should have it"},"exit_code":2}').encode()
CLI_STDERR_0_4_8 = '{"error":{"code":"usage","message":"unknown flag --irreversible"}}\n'


def served(exit_code, stdout='', stderr=''):
    return 200, json.dumps({'exit_code': exit_code, 'stdout': stdout, 'stderr': stderr, 'stdout_truncated': False,
                            'stderr_truncated': False}).encode()


def answer(**doc):
    return types.SimpleNamespace(ok=doc.get('ok') is True, doc=doc, exit_code=0, status=doc.get('status'))


def coded(code, **doc):
    return types.SimpleNamespace(ok=False, doc=doc, exit_code=code, status=doc.get('status'))


class Serve:
    """`approval serve` as av-events' `_transport` sees it. `proposes` scripts each propose answer in order: 'flag-ok'
    (a core that knows the flag), 'serve-403' / 'cli-usage' (core 0.4.8's two refusals), 'ok' (accepted, no flag
    needed), or a (status, body) / exception. A propose that is accepted answers `decision` for the bytes it got."""

    def __init__(self, proposes, decision='requested', state='requested'):
        self.proposes, self.decision, self.state, self.requests = list(proposes), decision, state, []

    def __call__(self, endpoint, path, body, headers):
        verb, req = path[len('/verb/'):], json.loads(body)
        self.requests.append((verb, req))
        flags = req.get('flags') or {}
        if verb == 'propose':
            step = self.proposes.pop(0)
            if isinstance(step, BaseException):
                raise step
            if isinstance(step, tuple):
                return step
            if step == 'serve-403':
                assert flags.get('--irreversible') is True
                return 403, SERVE_403_0_4_8
            if step == 'cli-usage':
                assert flags.get('--irreversible') is True
                return served(2, '', CLI_STDERR_0_4_8)
            assert step in ('flag-ok', 'ok') and (flags.get('--irreversible') is True) == (step == 'flag-ok'), (step, flags)
            doc = {'ok': True, 'task': TASK, 'action_key': flags['--key'], 'class': flags['--class'],
                   'payload_hash': hashlib.sha256(flags['--payload-json'].encode()).hexdigest(), 'decision': self.decision,
                   'state': self.state}
            return served(0, json.dumps(doc) + '\n')
        if verb == 'wait':
            return served(0, json.dumps({'ok': True, 'task': req['positionals'][0], 'status': 'granted'}) + '\n')
        if verb == 'start':
            return served(0, json.dumps({'ok': True, 'task': req['positionals'][0], 'authorization': 'grant'}) + '\n')
        raise AssertionError('unexpected verb ' + verb)

    def propose_flags(self):
        return [req['flags'] for verb, req in self.requests if verb == 'propose']

    def verbs(self):
        return [verb for verb, _ in self.requests]


class ForKicksIrreversibleTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    # The order fixtures test_forkicks.py uses (copied: its test class is not imported, so its tests run once).
    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'forkicks', **mini.FORKICKS}]}))
        if not hasattr(self, 'gate'):
            gate = patch.object(bridge, 'gate_verified', return_value=None); self.gate = gate.start(); self.addCleanup(gate.stop)

    def preview(self):
        draft = '550e8400-e29b-41d4-a716-446655440000'
        order = {'items': [{'itemId': 'coffee', 'qty': 2, 'optionIds': ['oat']}], 'fulfilment': {'type': 'pickup', 'locationId': 'cafe', 'date': '2026-10-19'}, 'paymentMethod': 'upi', 'note': 'less sugar'}
        quote = {'quoteId': 'quote-1', 'canOrder': True, 'totalInr': 380, 'location': {'name': 'Café', 'address': 'Mandrem, Goa', 'opens': '2026-10-19T08:00:00+05:30'}, 'lines': [{'name': 'Coffee', 'qty': 2, 'options': ['oat milk'], 'unitInr': 190, 'lineInr': 380}]}
        payload = {'appId': 'forkicks', 'operation': 'forkicks.order.confirm', 'preview': {'appId': 'forkicks', 'draftId': draft, **order, 'quote': quote, 'displayName': 'Test resident'}}
        return {'draftId': draft, 'quote': quote, 'displayName': 'Test resident', 'approvalPayload': payload, 'payloadHash': hashlib.sha256(fk.canonical(payload).encode()).hexdigest()}, order

    def prepare(self):
        """A saved draft (its prepare's own card is not this file's subject: the daemon is a stand-in there)."""
        self.enable()
        result, order = self.preview()
        self.transport.return_value = result
        with patch.object(fk, 'approval_modules', side_effect=ValueError('approval_unavailable')):
            response = self.call({'operation': 'forkicks.order.prepare', **order})
        self.assertEqual(response['data'], result)
        self.transport.reset_mock()
        self.transport.return_value = {'orderId': 'order-1', 'number': '#042', 'payment': {'simulated': True, 'label': 'Test payment, no money moved'}}
        return result, order

    def next_turn(self):
        self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')

    def record(self, result):
        return fk.load_preview(Path(self.tmp.name), result['draftId'], self.config)

    def key(self, result):
        return 'marketplace.app.action:forkicks.order.confirm:' + result['draftId']

    def fresh(self, result):
        self.transport.reset_mock()
        for suffix in ('.card', '.placed', '.await', '.refused'):
            Path(self.tmp.name, 'forkicks-drafts', result['draftId'] + suffix).unlink(missing_ok=True)

    def real_client(self, serve):
        env = patch.dict('os.environ', {'AV_APPROVAL_ENABLED': '1', 'AV_APPROVAL_URL': 'https://approval.example',
                                        'AV_APPROVAL_TOKEN': 'agent-token-for-the-forkicks-tests-001'})
        env.start(); self.addCleanup(env.stop)
        seam = patch.object(client, '_transport', serve); seam.start(); self.addCleanup(seam.stop)
        return client

    # ---- the flag ---------------------------------------------------------------------------------------------

    def test_the_one_propose_asks_core_for_the_irreversibility_floor(self):
        result, _ = self.prepare()
        ap = Mock()
        ap.propose.return_value = answer(ok=True, task=TASK, decision='requested', state='requested', payload_hash=result['payloadHash'])
        ap.wait.return_value = coded(6, status='requested')
        with patch.object(fk, 'approval_modules', return_value=ap):
            fk.authorize_order(self.record(result), result['draftId'])
        ap.propose.assert_called_once()
        self.assertEqual(ap.propose.call_args.kwargs, {'irreversible': True})
        self.assertEqual(ap.propose.call_args.args[:2], (fk.APPROVAL_CLASS, self.key(result)))
        # The class-diff entry and core's NEW-CALLS extractor read the propose at exactly this line, flag included.
        line = Path(fk.__file__).read_text(encoding='utf-8').splitlines()[344]
        self.assertEqual(line.strip(), 'answer = ap.propose(APPROVAL_CLASS, key, summary, held, irreversible=True)')

    def test_through_the_real_client_each_core_gets_a_card_and_the_order_is_placed_on_the_grant(self):
        for label, proposes, sent in (
            ('a core that knows the flag', ['flag-ok'], [True]),
            ('core 0.4.8 behind serve (403, retried once)', ['serve-403', 'ok'], [True, False]),
            ('core 0.4.8 at the CLI (usage exit 2, retried once)', ['cli-usage', 'ok'], [True, False]),
        ):
            with self.subTest(label):
                result, _ = self.prepare()
                self.fresh(result)
                serve = Serve(proposes)
                ap = self.real_client(serve)
                proposed = []
                with patch.object(fk, 'approval_modules', return_value=ap):
                    proof, refusal = fk.authorize_order(self.record(result), result['draftId'], on_proposed=proposed.append)
                self.assertIsNone(refusal)
                self.assertEqual(proof['taskId'], TASK); self.assertEqual(proposed, [TASK])
                self.assertEqual([f.get('--irreversible') is True for f in serve.propose_flags()], sent)
                self.assertEqual(serve.verbs(), ['propose'] * len(sent) + ['wait', 'start'])
                # The retry sends the same request less the flag: same class, key, summary and bytes.
                if len(sent) == 2:
                    first, last = serve.propose_flags()
                    self.assertEqual({k: v for k, v in first.items() if k != '--irreversible'}, last)
                self.assertNotIn('--irreversible', [k for f in serve.propose_flags()[1:] for k in f])

    def test_the_confirm_places_the_order_on_core_0_4_8_exactly_as_before(self):
        result, _ = self.prepare(); self.next_turn()
        for step in ('serve-403', 'cli-usage'):
            with self.subTest(step):
                self.fresh(result)
                serve = Serve([step, 'ok'])
                with patch.object(fk, 'approval_modules', return_value=self.real_client(serve)):
                    output = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId']})
                self.assertEqual(output['data']['orderId'], 'order-1')
                self.assertEqual(self.transport.call_args.args[1]['approval']['taskId'], TASK)
                self.assertEqual(len(serve.propose_flags()), 2)

    def test_any_other_refusal_of_the_flagged_propose_is_not_retried_and_places_nothing(self):
        cases = {
            'serve: another flag refused': ((403, b'{"error":{"code":"serve-flag-not-permitted","message":"--bogus is not accepted on `approval propose` from the agent credential,"},"exit_code":2}'), 'approval_unavailable'),
            'serve: agent forbidden': ((403, b'{"error":{"code":"serve-agent-forbidden","message":"x"},"exit_code":2}'), 'approval_unavailable'),
            'serve: 403 without a body': ((403, b''), 'approval_unavailable'),
            'serve: the flag refusal under 400': ((400, SERVE_403_0_4_8), 'approval_unavailable'),
            'cli: another usage error': (served(2, '', '{"error":{"code":"usage","message":"missing --key <key>"}}\n'), 'approval_refused'),
            'cli: another unknown flag': (served(2, '', '{"error":{"code":"usage","message":"unknown flag --bogus"}}\n'), 'approval_refused'),
            'cli: the message at exit 1': (served(1, '', CLI_STDERR_0_4_8), 'approval_refused'),
            'cli: class not requestable': (served(1, '', '{"error":{"code":"class-not-agent-requestable","message":"x"}}\n'), 'approval_refused'),
            'no answer': (ConnectionResetError('reset'), 'approval_unavailable'),
        }
        result, _ = self.prepare(); self.next_turn()
        for label, (first, code) in cases.items():
            with self.subTest(label):
                self.fresh(result)
                serve = Serve([first, AssertionError('never retried')])
                with patch.object(fk, 'approval_modules', return_value=self.real_client(serve)):
                    output = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId']})
                self.assertEqual(output['error'], code)
                self.assertEqual(serve.verbs(), ['propose']); self.assertIs(serve.propose_flags()[0]['--irreversible'], True)
                self.transport.assert_not_called()
                self.assertFalse(Path(self.tmp.name, 'forkicks-drafts', result['draftId'] + '.card').exists())

    def test_a_failure_of_the_retry_places_nothing_and_is_never_retried_again(self):
        result, _ = self.prepare(); self.next_turn()
        for first in ('serve-403', 'cli-usage'):
            for second, code in (((403, SERVE_403_0_4_8), 'approval_unavailable'), (ConnectionResetError('reset'), 'approval_unavailable'),
                                 (served(2, '', CLI_STDERR_0_4_8), 'approval_refused'),
                                 (served(1, '', '{"error":{"code":"duplicate-request","message":"x"}}\n'), 'approval_refused')):
                with self.subTest(first=first, second=repr(second)[:60]):
                    self.fresh(result)
                    serve = Serve([first, second, AssertionError('no third propose')])
                    with patch.object(fk, 'approval_modules', return_value=self.real_client(serve)):
                        output = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId']})
                    self.assertEqual(output['error'], code)
                    self.assertEqual(serve.verbs(), ['propose', 'propose'])
                    self.transport.assert_not_called()

    def test_only_requested_is_accepted_with_the_flag_and_after_the_retry(self):
        result, _ = self.prepare()
        for proposes in (['flag-ok'], ['serve-403', 'ok'], ['cli-usage', 'ok']):
            for decision, state in (('autonomous', None), ('supervised', None), ('autonomous', 'executed'),
                                    ('supervised', 'executed'), ('human-only', None), (None, None), ('Requested', None)):
                with self.subTest(proposes=proposes[0], decision=decision, state=state):
                    self.fresh(result)
                    serve = Serve(proposes, decision=decision, state=state)
                    proposed = []
                    with patch.object(fk, 'approval_modules', return_value=self.real_client(serve)):
                        proof, refusal = fk.authorize_order(self.record(result), result['draftId'], on_proposed=proposed.append)
                    self.assertEqual((proof, refusal), (None, {'error': 'approval_refused'}))
                    self.assertEqual(proposed, [])
                    self.assertEqual(serve.verbs(), ['propose'] * len(proposes))  # no wait, no start

    # ---- review-b #628 N2: a replayed prepare of a started draft ---------------------------------------------------

    def executed_daemon(self, result, wait):
        ap = Mock()
        ap.propose.return_value = answer(ok=True, task=TASK, decision='requested', state='executed', payload_hash=result['payloadHash'])
        if isinstance(wait, BaseException):
            ap.wait.side_effect = wait
        else:
            ap.wait.return_value = wait
        ap.start.side_effect = AssertionError('no start')
        return ap

    def unknown_reads(self, key):
        return {'wait raises': RuntimeError('timeout'), 'log unreadable (exit 4)': coded(4, error={'code': 'log-unreadable'}),
                'no actions': answer(status='executed', actions=[]),
                'another key granted': answer(status='nothing-to-wait-for', actions=[{'action_key': key + 'x', 'state': 'granted'}])}

    def test_n2_a_replayed_prepare_of_a_started_draft_never_says_a_card_was_sent(self):
        result, order = self.prepare(); self.next_turn(); key = self.key(result)
        for label, read in self.unknown_reads(key).items():
            with self.subTest(label):
                self.fresh(result); self.transport.return_value = result
                ap = self.executed_daemon(result, read)
                tracked = Mock(return_value=mini.ORDER_PLACED_ON_APPROVAL)  # what the pass would answer for a card
                with patch.object(fk, 'approval_modules', return_value=ap), patch.object(grant, 'instruction_if_tracked', tracked):
                    response = self.call({'operation': 'forkicks.order.prepare', **order})
                self.assertEqual(response['data'], result)
                self.assertEqual((response['approval'], response['error'], response['instruction']),
                                 ('unavailable', 'approval_unavailable', mini.ORDER_STARTED_UNREAD))
                self.assertNotIn('started', response)
                for words in ("I've sent your approval card", 'tap Approve', 'so nothing was ordered', "haven't ordered"):
                    self.assertNotIn(words, response['instruction'])
                # The pass is still handed the task (it confirms a person's spent grant and tells the owner).
                tracked.assert_called_once(); self.assertEqual(tracked.call_args.args[2], TASK)
                ap.propose.assert_called_once(); ap.wait.assert_called_once_with(TASK)
                self.transport.assert_called_once()  # the prepare itself; no confirm

    def test_n2_the_confirm_answer_for_the_same_reads_is_unchanged(self):
        result, _ = self.prepare(); self.next_turn(); key = self.key(result)
        for label, read in self.unknown_reads(key).items():
            with self.subTest(label):
                self.fresh(result)
                with patch.object(fk, 'approval_modules', return_value=self.executed_daemon(result, read)):
                    output = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId']})
                self.assertEqual(output, {'error': 'approval_unavailable', 'instruction': mini.ORDER_APPROVAL_UNAVAILABLE})
                self.transport.assert_not_called()

    def test_n2_authorize_order_marks_only_the_started_unknown_read(self):
        result, _ = self.prepare(); key = self.key(result)
        for label, read in self.unknown_reads(key).items():
            with self.subTest(label):
                self.fresh(result)
                with patch.object(fk, 'approval_modules', return_value=self.executed_daemon(result, read)):
                    self.assertEqual(fk.authorize_order(self.record(result), result['draftId']),
                                     (None, {'error': 'approval_unavailable', 'instruction': mini.ORDER_APPROVAL_UNAVAILABLE, 'started': True}))
        # A fresh request whose read fails is NOT marked: its card is out (prepare says so; the confirm retries).
        self.fresh(result)
        ap = self.executed_daemon(result, RuntimeError('timeout'))
        ap.propose.return_value = answer(ok=True, task=TASK, decision='requested', state='requested', payload_hash=result['payloadHash'])
        with patch.object(fk, 'approval_modules', return_value=ap):
            with self.assertRaises(RuntimeError):
                fk.authorize_order(self.record(result), result['draftId'])

    # ---- review-b #628 N3: a known task started without its own grant ----------------------------------------------

    def known(self, result, read, **kw):
        ap = Mock()
        ap.propose.side_effect = AssertionError('a known task is never proposed again')
        ap.wait.return_value = read
        ap.start.return_value = answer(ok=True, authorization='grant')
        on_requested = Mock(return_value='tracked')
        with patch.object(fk, 'approval_modules', return_value=ap):
            out = fk.authorize_order(self.record(result), result['draftId'], known_task=TASK, on_requested=on_requested, **kw)
        return out, ap, on_requested

    def test_n3_a_known_task_started_by_policy_is_the_closed_card_not_approve_on_its_card(self):
        result, _ = self.prepare(); key = self.key(result)
        for status in ('executed', 'nothing-to-wait-for'):
            with self.subTest(status=status):
                (proof, refusal), ap, on_requested = self.known(result, answer(status=status, actions=[{'action_key': key, 'state': 'executed'}]))
                self.assertEqual((proof, refusal), (None, {'error': 'approval_card_closed', 'instruction': mini.ORDER_CARD_CLOSED}))
                on_requested.assert_not_called(); ap.start.assert_not_called()

    def test_n3_a_known_task_spent_without_a_readable_grant_is_could_not_run_not_approve_on_its_card(self):
        result, _ = self.prepare(); key = self.key(result)
        for label, read in {'no actions': answer(status='nothing-to-wait-for', actions=[]),
                            'actions absent': answer(status='executed'),
                            'another key granted': answer(status='executed', actions=[{'action_key': key[:-1] + '9', 'state': 'granted'}]),
                            'own withdrawn': answer(status='executed', actions=[{'action_key': key, 'state': 'withdrawn'}]),
                            'two of mine': answer(status='executed', actions=[{'action_key': key, 'state': 'granted'}] * 2)}.items():
            with self.subTest(label):
                (proof, refusal), ap, on_requested = self.known(result, read)
                self.assertEqual((proof, refusal), (None, {'error': 'approval_unavailable', 'instruction': mini.ORDER_APPROVAL_UNAVAILABLE, 'started': True}))
                self.assertNotEqual(refusal['instruction'], mini.ORDER_APPROVE_IN_BOT)
                on_requested.assert_not_called(); ap.start.assert_not_called()

    def test_n3_the_known_task_reads_that_were_right_are_unchanged(self):
        result, _ = self.prepare(); key = self.key(result)
        (proof, refusal), ap, _ = self.known(result, answer(status='nothing-to-wait-for', actions=[{'action_key': key, 'state': 'granted'}]))
        self.assertEqual((proof['taskId'], refusal), (TASK, None)); ap.start.assert_not_called()  # adopted
        (proof, refusal), ap, on_requested = self.known(result, coded(6, status='requested'))
        self.assertEqual((proof, refusal), (None, {'error': 'approval_required', 'instruction': 'tracked'}))
        on_requested.assert_called_once_with(TASK)
        (proof, refusal), ap, _ = self.known(result, answer(status='granted'))
        self.assertEqual((proof['taskId'], refusal), (TASK, None)); ap.start.assert_called_once()
        for status in ('rejected', 'withdrawn', 'expired', 'void'):
            (proof, refusal), _, _ = self.known(result, coded(1 if status != 'expired' else 3, status=status))
            self.assertEqual(refusal['error'], 'approval_card_closed')
        # A spent read is not taken for the closed card or the could-not-run answer at exit 6 or exit 0 + granted.
        (proof, refusal), _, _ = self.known(result, coded(6, status='executed', actions=[{'action_key': key, 'state': 'executed'}]))
        self.assertEqual(refusal['error'], 'approval_required')

    def test_n3_through_the_confirm_and_the_prepare(self):
        result, order = self.prepare(); self.next_turn(); key = self.key(result)
        read = answer(status='nothing-to-wait-for', actions=[])
        for op in ('confirm', 'prepare'):
            with self.subTest(op):
                self.fresh(result)
                self.assertTrue(grant.record_card(Path(self.tmp.name), result['draftId'], TASK))
                self.assertEqual(grant.card_task(Path(self.tmp.name), result['draftId']), TASK)
                ap = Mock(); ap.propose.side_effect = AssertionError('no propose'); ap.wait.return_value = read
                self.transport.return_value = result
                with patch.object(fk, 'approval_modules', return_value=ap), patch.object(grant, 'instruction_if_tracked', Mock(return_value=None)):
                    if op == 'confirm':
                        output = self.call({'operation': 'forkicks.order.confirm', 'draftId': result['draftId']})
                        self.assertEqual(output, {'error': 'approval_unavailable', 'instruction': mini.ORDER_APPROVAL_UNAVAILABLE})
                    else:
                        output = self.call({'operation': 'forkicks.order.prepare', **order})
                        self.assertEqual((output['approval'], output['instruction']), ('unavailable', mini.ORDER_STARTED_UNREAD))
                ap.start.assert_not_called()
