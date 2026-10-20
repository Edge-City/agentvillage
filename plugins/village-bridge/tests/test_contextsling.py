"""Synthetic CX-2 manual boundary, exact-byte and installed-only tests; no external calls."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

fixture = sys.modules.get('village_bridge_test_fixture')
if fixture is None:
    spec = importlib.util.spec_from_file_location('village_bridge_test_fixture', Path(__file__).with_name('test_bridge.py'))
    fixture = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = fixture
    spec.loader.exec_module(fixture)
bridge, mini = fixture.bridge, fixture.mini
cx = sys.modules['village_bridge._contextsling']
VECTORS = json.loads(Path(__file__).with_name('contextsling-vectors.json').read_text())

def answer(**doc):
    return types.SimpleNamespace(ok=doc.get('ok') is True, doc=doc, exit_code=0, status=doc.get('status'))

class ContextslingTest(unittest.TestCase):
    setUp = fixture.BridgeTest.setUp
    call = fixture.BridgeTest.call

    def enable(self):
        Path(self.tmp.name, 'mini-apps.json').write_text(json.dumps({'version': 1, 'apps': [{'id': 'contextsling', **mini.CONTEXTSLING}]}))
        if not hasattr(self, 'gate'):
            gate = patch.object(bridge, 'gate_verified', return_value=None)
            self.gate = gate.start(); self.addCleanup(gate.stop)

    def preview(self, op='publish'):
        payload = copy.deepcopy(VECTORS['vectors'][0]['payload'])
        payload['operation'] = 'contextsling.' + op
        p = payload['preview']
        p['expiresAt'] = (datetime.now(timezone.utc) + timedelta(minutes=59)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        if op == 'update': p['target'] = {'bundleId': 'own-bundle', 'expectedRevision': 2}
        if op == 'revoke':
            del p['file']; p['target'] = {'bundleId': 'own-bundle', 'title': 'Own draft'}
        return {'draftId': p['draftId'], 'operation': payload['operation'], 'preview': p,
                'approvalPayload': payload, 'payloadHash': hashlib.sha256(cx.canonical(payload).encode()).hexdigest()}

    def prepare(self, op='publish'):
        self.enable(); result = self.preview(op)
        self.transport.return_value = result
        p = result['preview']
        request = {'operation': 'contextsling.prepare', 'action': op}
        if 'file' in p: request['file'] = {k: p['file'][k] for k in ('name', 'lines', 'finalNewline')}
        if 'target' in p: request['target'] = p['target']
        self.assertEqual(self.call(request)['data'], result)
        self.transport.reset_mock()
        self.transport.return_value = {'kind': 'contextsling.write', 'state': 'confirmed', 'draftId': result['draftId'], 'operation': result['operation'], 'bundleId': 'own-bundle'}
        return result

    def next_turn(self): self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')

    def daemon(self, decision='requested', status='granted', authorization='grant'):
        ap = Mock()
        ap.propose.side_effect = lambda cls, key, summary, held: answer(ok=True, task='propose:'+'a'*32, decision=decision, payload_hash=hashlib.sha256(held.encode()).hexdigest())
        ap.wait.return_value = answer(status=status)
        ap.start.return_value = answer(ok=True, authorization=authorization)
        ap.withdraw.return_value = answer(ok=True)
        return ap

    def confirm(self, result): return self.call({'operation': result['operation'], 'draftId': result['draftId']})

    def test_shared_vectors_exact_canonical_digest_and_card(self):
        for vector in VECTORS['vectors']:
            with self.subTest(vector=vector['id']):
                p = vector['payload']
                self.assertEqual(cx.canonical(p), vector['canonical'])
                self.assertEqual(hashlib.sha256(cx.canonical(p).encode()).hexdigest(), vector['payloadHash'])
                self.assertEqual(cx.approval_summary(p), vector['summary'])
        self.assertEqual(VECTORS['constants'], {'maxPayloadBytes': cx.MAX_PAYLOAD_BYTES, 'maxCardBytes': cx.MAX_CARD_BYTES, 'maxEscapedBytes': cx.MAX_ESCAPED_BYTES, 'draftWindowMs': cx.DRAFT_WINDOW_MS})

    def test_forbidden_unicode_in_each_display_field_rejected(self):
        for vector in VECTORS['rejected']:
            for field in ('line', 'name', 'title'):
                p = self.preview('revoke' if field == 'title' else 'publish')['approvalPayload']
                if field == 'title': p['preview']['target']['title'] = 'bad'+vector['value']
                elif field == 'name': p['preview']['file']['name'] = 'bad'+vector['value']
                else: p['preview']['file']['lines'][0] = 'bad'+vector['value']
                with self.assertRaisesRegex(ValueError, 'approval_card_invalid'): cx.approval_summary(p)

    def test_unknown_nested_keys_bad_hash_counts_types_and_date_refused(self):
        base = self.preview()['approvalPayload']
        mutations = [lambda p: p.update(extra=True), lambda p: p['preview'].update(extra=True), lambda p: p['preview']['file'].update(url='https://example.com'), lambda p: p['preview']['file'].update(bytes=True), lambda p: p['preview']['file'].update(sha256='a'*64), lambda p: p['preview'].update(connection=True), lambda p: p['preview'].update(connection=9007199254740992), lambda p: p['preview'].update(draftId='short'), lambda p: p['preview'].update(expiresAt='2026-02-30T00:00:00.000Z'), lambda p: p['preview'].update(expiresAt='2026-10-19T00:00:00Z')]
        for mutate in mutations:
            p = copy.deepcopy(base); mutate(p)
            with self.assertRaises(ValueError): cx.validate_payload(p)

    def test_html_card_budget_refuses_without_truncation(self):
        result = self.preview(); p = result['preview']['file']; p['lines'] = ['<'*700]
        p['bytes'] = 700; p['finalNewline'] = False; p['sha256'] = hashlib.sha256(b'<'*700).hexdigest()
        with self.assertRaisesRegex(ValueError, 'approval_card_too_long'): cx.approval_summary(result['approvalPayload'])
        self.enable()
        with patch.object(cx, 'approval_modules') as modules:
            out = self.call({'operation':'contextsling.prepare','action':'publish','file': {k:p[k] for k in ('name','lines','finalNewline')}})
        self.assertEqual(out['error'],'approval_card_too_long'); modules.assert_not_called(); self.transport.assert_not_called()

    def test_installed_exact_projection_and_no_context_permission(self):
        self.enable()
        for op in mini.CONTEXTSLING['operations']: self.assertTrue(mini.installed(Path(self.tmp.name), 'contextsling', op))
        self.assertFalse(mini.installed(Path(self.tmp.name), 'contextsling', 'mini-app.context.read'))
        self.assertFalse(mini.installed(Path(self.tmp.name), 'contextsling', 'mini-app.context.write'))
        entry = {'id':'contextsling', **mini.CONTEXTSLING, 'operations':list(reversed(mini.CONTEXTSLING['operations']))}
        Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[entry]}))
        self.assertEqual(self.call({'operation':'contextsling.usage'})['error'],'mini_app_not_installed')
        self.transport.assert_not_called()

    def test_reads_exact_shapes_and_no_auth_for_reads(self):
        self.enable()
        for request in ({'operation':'contextsling.list','limit':25,'cursor':0}, {'operation':'contextsling.manifest','bundleId':'own','revision':2}, {'operation':'contextsling.read','bundleId':'own','revision':2}, {'operation':'contextsling.usage'}):
            self.assertIn('data', self.call(request)); self.transport.assert_called_with(self.config,request)
        self.gate.assert_not_called()
        for request in ({'operation':'contextsling.list','limit':26}, {'operation':'contextsling.read','bundleId':'own','revision':'2'}, {'operation':'contextsling.read','bundleId':'own','revision':2,'fileId':'extra'}, {'operation':'contextsling.usage','tool':'publish_bundle'}):
            self.assertEqual(self.call(request)['error'],'invalid_arguments')

    def test_prepare_verified_gate_and_no_daemon_or_dispatch(self):
        self.enable(); self.gate.side_effect = ValueError('gate_off')
        request = {'operation':'contextsling.prepare','action':'publish','file':{'name':'x.md','lines':['hello'],'finalNewline':False}}
        with patch.object(cx,'approval_modules') as modules:
            self.assertEqual(self.call(request)['error'],'approval_unavailable')
        self.transport.assert_not_called(); modules.assert_not_called()

    def test_later_turn_same_session_no_model_proof(self):
        result = self.prepare()
        self.assertEqual(self.confirm(result)['error'],'contextsling_confirmation_required')
        self.next_turn()
        self.assertEqual(self.call({'operation':result['operation'],'draftId':result['draftId'],'approval':{'granted':True}})['error'],'invalid_arguments')
        self.sc._VAR_MAP['HERMES_SESSION_KEY'].set('different-session')
        self.assertEqual(self.confirm(result)['error'],'contextsling_confirmation_required')
        self.transport.assert_not_called()

    def test_all_write_operations_manual_exact_card_and_hash(self):
        for op in ('publish','update','revoke'):
            with self.subTest(op=op):
                self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
                result = self.prepare(op); self.next_turn(); ap=self.daemon()
                with patch.object(cx,'approval_modules',return_value=ap): out=self.confirm(result)
                self.assertEqual(out['data']['state'],'confirmed')
                self.assertEqual(ap.propose.call_args.args[:3], ('marketplace.app.action','marketplace.app.action:contextsling.'+op+':'+result['draftId'],cx.approval_summary(result['approvalPayload'])))
                proof=self.transport.call_args.args[1]['approval']; self.assertEqual(proof['payload'],result['approvalPayload']); self.assertEqual(proof['payloadHash'],result['payloadHash'])
                path=Path(self.tmp.name,'contextsling-drafts',result['draftId']+'.json')
                cached=json.loads(path.read_text()); self.assertNotIn('payload',cached); self.assertNotIn('url',cached)
                path.unlink(); path.with_suffix('.lock').unlink()

    def test_pending_next_turn_uses_same_task_no_reproposal_and_tap_no_dispatch(self):
        result=self.prepare(); self.next_turn(); ap=self.daemon(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap):
            self.assertEqual(self.confirm(result)['error'],'approval_required')
            self.transport.assert_not_called(); ap.start.assert_not_called()
            ap.wait.return_value=answer(status='granted')
            self.assertEqual(self.confirm(result)['data']['state'],'confirmed')
        ap.propose.assert_called_once()

    def test_rejected_is_terminal_deletes_body_and_never_reproposes(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected')
        self.transport.return_value={'kind':'contextsling.write','state':'declined','operation':result['operation'],'draftId':result['draftId']}
        with patch.object(cx,'approval_modules',return_value=ap):
            for _ in range(2): self.assertEqual(self.confirm(result)['error'],'contextsling_declined')
        ap.propose.assert_called_once();ap.start.assert_not_called()
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId'],'declined':True})
        self.assertNotIn('payload',cx.load_preview(Path(self.tmp.name),result['draftId'],self.config))

    def test_policy_and_never_decisions_cannot_start(self):
        result=self.prepare();self.next_turn()
        for decision in ('autonomous','supervised','never',None):
            ap=self.daemon(decision=decision)
            with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'approval_refused')
            ap.start.assert_not_called()
        self.transport.assert_not_called()

    def test_policy_start_refused_even_after_grant(self):
        result=self.prepare();self.next_turn();ap=self.daemon(authorization='policy')
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'approval_not_started')
        self.transport.assert_not_called()

    def test_expired_pending_withdrawn_on_next_turn_and_body_removed(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'approval_required')
        record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        self.transport.return_value={'error':'contextsling_approval_required'}
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',return_value=ap):
            cx.cleanup_expired(Path(self.tmp.name),self.config)
            self.assertEqual(self.confirm(result)['data']['error'],'contextsling_approval_required')
        ap.withdraw.assert_called_once();ap.start.assert_not_called()
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId']})
        self.assertNotIn('payload',cx.load_preview(Path(self.tmp.name),result['draftId'],self.config))

    def test_expiry_during_wait_never_starts(self):
        result=self.prepare();self.next_turn();ap=self.daemon()
        with patch.object(cx,'approval_modules',return_value=ap),patch.object(cx,'expired',side_effect=[False,True]):
            record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
            self.assertEqual(cx.authorize_action(Path(self.tmp.name),record,result['draftId'])[1]['error'],'contextsling_expired')
        ap.start.assert_not_called();self.transport.assert_not_called()

    def test_unknown_outcome_preserves_same_draft(self):
        result=self.prepare();self.next_turn();ap=self.daemon();self.transport.return_value={}
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['data']['error'],'contextsling_unconfirmed')
        self.assertIn('payload',cx.load_preview(Path(self.tmp.name),result['draftId'],self.config))

    def test_terminal_disconnect_error_deletes_bytes_and_hides_upstream_text(self):
        result=self.prepare();self.next_turn();ap=self.daemon()
        self.transport.return_value={'error':'contextsling_not_connected','instruction':'LEAK secret token','url':'https://cap.invalid'}
        with patch.object(cx,'approval_modules',return_value=ap): out=self.confirm(result)
        self.assertNotIn('LEAK',json.dumps(out));self.assertNotIn('cap.invalid',json.dumps(out))
        self.assertNotIn('payload',cx.load_preview(Path(self.tmp.name),result['draftId'],self.config))

    def test_cron_and_group_refused_before_transport(self):
        self.enable()
        self.sc._VAR_MAP['HERMES_CRON_SESSION'].set(True)
        for op in mini.CONTEXTSLING['operations']: self.assertEqual(self.call({'operation':op})['error'],'private_owner_chat_required')
        self.transport.assert_not_called()

    def test_registered_enum_only_on_installed_box_description_unchanged(self):
        original=copy.deepcopy(bridge.SCHEMA)
        bridge._REGISTERED=False
        ctx=Mock();bridge.register(ctx)
        self.assertEqual(ctx.register_tool.call_args.kwargs['schema'],original)
        self.enable();bridge._REGISTERED=False;bridge.register(ctx)
        schema=ctx.register_tool.call_args.kwargs['schema']
        self.assertEqual(schema['description'],original['description'])
        self.assertEqual(schema['parameters']['properties']['operation']['enum'],original['parameters']['properties']['operation']['enum']+mini.CONTEXTSLING['operations'])
        self.assertEqual(bridge.SCHEMA,original)

    def test_next_owner_turn_hook_cleans_without_village_call_or_dispatch(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'approval_required')
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',return_value=ap):
            bridge.cleanup_contextsling_turn()
        ap.withdraw.assert_called_once();self.transport.assert_not_called();ap.start.assert_not_called()
        self.assertNotIn('payload',cx.load_preview(Path(self.tmp.name),result['draftId'],self.config))

    def test_daemon_outage_still_removes_expired_body_and_retries_withdrawal(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',side_effect=ValueError('offline')):
            cx.cleanup_expired(Path(self.tmp.name),self.config)
        record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        self.assertNotIn('payload',record);self.assertTrue(record['pendingWithdrawal'])
        with patch.object(cx,'approval_modules',return_value=ap): cx.cleanup_expired(Path(self.tmp.name),self.config)
        ap.withdraw.assert_called_once()

    def test_manifest_ceiling_and_closed_event_declarations_are_safe(self):
        root=Path(__file__).resolve().parents[3]
        manifest=json.loads((root/'plugins/village-bridge/contextsling/manifest.json').read_text())
        self.assertEqual(manifest['contextCeiling'],cx.CONTEXT_CEILING)
        self.assertIs(manifest['listed'],False)
        self.assertEqual(manifest['operations'],mini.CONTEXTSLING['operations'])
        schemas=json.loads((root/'plugins/village-bridge/contextsling/events.schema.json').read_text())['events']
        self.assertEqual(set(schemas),{'miniapp.'+op+'@1' for op in mini.CONTEXTSLING['operations']})
        for schema in schemas.values():
            self.assertFalse(schema['additionalProperties'])
            self.assertEqual(set(schema['properties']),{'ok','count','payloadHash'})
            self.assertEqual(schema['required'],['ok','count'])

    def test_hash_owner_symlink_and_prepare_replay_cannot_move_boundary(self):
        result=self.prepare();self.next_turn()
        cx.save_preview(Path(self.tmp.name),result,bridge.bound_context(),self.config)
        record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        self.assertEqual(record['message'],'9')
        path=cx.cache_path(Path(self.tmp.name),result['draftId'])
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertNotIn(self.config['token'],path.read_text())
        with self.assertRaises(ValueError): cx.load_preview(Path(self.tmp.name),result['draftId'],{**self.config,'ownerTelegramId':'99'})
        record['payload']['preview']['connection']+=1
        path.write_text(cx.canonical(record))
        self.assertEqual(self.confirm(result)['error'],'approval_preview_unavailable')
        path.unlink();other=Path(self.tmp.name,'other');other.write_text('private');path.symlink_to(other)
        self.assertEqual(self.confirm(result)['error'],'approval_preview_unavailable')
        self.transport.assert_not_called()

    def test_prepare_deadline_cannot_exceed_sixty_minutes(self):
        self.enable();result=self.preview()
        result['preview']['expiresAt']=(datetime.now(timezone.utc)+timedelta(minutes=61)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        result['payloadHash']=hashlib.sha256(cx.canonical(result['approvalPayload']).encode()).hexdigest()
        with self.assertRaisesRegex(ValueError,'contextsling_expired'):
            cx.save_preview(Path(self.tmp.name),result,bridge.bound_context(),self.config)
        self.assertFalse(Path(self.tmp.name,'contextsling-drafts').exists())

    def test_uncertain_dispatch_expiry_recovers_read_only_without_absence_claim(self):
        result=self.prepare();self.next_turn();ap=self.daemon();self.transport.return_value={}
        with patch.object(cx,'approval_modules',return_value=ap):
            self.assertEqual(self.confirm(result)['data']['error'],'contextsling_unconfirmed')
        self.transport.reset_mock();ap.reset_mock()
        ap.wait.return_value=answer(status='executed')
        receipt={'kind':'contextsling.write','state':'confirmed','operation':result['operation'],'draftId':result['draftId'],'bundleId':'own','replayed':True}
        self.transport.return_value=receipt
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',return_value=ap):
            out=self.confirm(result)
        self.assertEqual(out['data'],receipt)
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId']})
        ap.propose.assert_not_called();ap.start.assert_not_called()
        record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        self.assertNotIn('payload',record);self.assertEqual(record['operation'],result['operation']);self.assertEqual(record['draftId'],result['draftId'])
        self.assertNotIn('nothing was published',json.dumps(out).lower())

    def test_completed_lost_response_recovers_same_receipt_and_refuses_wrong_op_or_binding(self):
        result=self.prepare();self.next_turn();ap=self.daemon()
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        self.transport.reset_mock();ap.reset_mock()
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['data']['state'],'confirmed')
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId']})
        ap.propose.assert_not_called();ap.start.assert_not_called();ap.wait.assert_not_called()
        self.transport.reset_mock()
        self.assertEqual(self.call({'operation':'contextsling.update','draftId':result['draftId']})['error'],'approval_preview_unavailable')
        self.transport.assert_not_called()
        self.transport.return_value={'error':'contextsling_connection_changed'}
        self.assertEqual(self.confirm(result)['data']['error'],'contextsling_connection_changed')
        self.transport.reset_mock()
        self.assertEqual(self.confirm(result)['error'],'contextsling_connection_changed');self.transport.assert_not_called()
        Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[]}))
        self.assertEqual(self.confirm(result)['error'],'mini_app_not_installed')

    def test_unknown_wait_keeps_withdraw_marker_then_later_closes_pending(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        ap.wait.return_value=types.SimpleNamespace(exit_code=2,status=None,doc={'error':{'code':'unavailable'}},ok=False)
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',return_value=ap): cx.cleanup_expired(Path(self.tmp.name),self.config)
        record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        self.assertTrue(record['pendingWithdrawal']);self.assertNotIn('payload',record);ap.withdraw.assert_not_called()
        ap.wait.return_value=answer(status='requested')
        with patch.object(cx,'approval_modules',return_value=ap): cx.cleanup_expired(Path(self.tmp.name),self.config)
        ap.withdraw.assert_called_once()
        self.assertFalse(cx.load_preview(Path(self.tmp.name),result['draftId'],self.config).get('pendingWithdrawal'))

    def test_expired_foreign_owner_or_origin_bytes_deleted_without_foreign_daemon_call(self):
        for changed in ({'ownerTelegramId':'99'},{'origin':'https://different.example'}):
            with self.subTest(changed=changed):
                self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('9')
                result=self.prepare();self.next_turn();ap=self.daemon(status='requested')
                with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
                ap.reset_mock()
                with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules',return_value=ap): cx.cleanup_expired(Path(self.tmp.name),{**self.config,**changed})
                ap.wait.assert_not_called();ap.withdraw.assert_not_called()
                record=cx.load_record(Path(self.tmp.name),result['draftId'])
                self.assertNotIn('payload',record);self.assertTrue(record['pendingWithdrawal'])
                self.assertEqual(record['owner'],self.config['ownerTelegramId']);self.assertEqual(record['origin'],self.config['origin'])
                with patch.object(cx,'approval_modules',return_value=ap): cx.cleanup_expired(Path(self.tmp.name),self.config)
                ap.withdraw.assert_called_once()
                path=cx.cache_path(Path(self.tmp.name),result['draftId']);path.unlink();path.with_suffix('.lock').unlink()

    def test_crashed_atomic_write_orphan_is_removed_at_its_validated_deadline(self):
        result=self.prepare();record=cx.load_preview(Path(self.tmp.name),result['draftId'],self.config)
        path=cx.cache_path(Path(self.tmp.name),result['draftId'])
        child=os.fork()
        if child == 0:
            cx.os.replace=lambda *args: os._exit(17)
            cx.write_record(path,record)
            os._exit(99)
        _,status=os.waitpid(child,0)
        self.assertEqual(os.waitstatus_to_exitcode(status),17)
        orphans=list(path.parent.glob(result['draftId']+'.tmp-*'))
        self.assertEqual(len(orphans),1);self.assertIn('payload',json.loads(orphans[0].read_text()))
        with patch.object(cx,'expired',return_value=True): cx.cleanup_expired(Path(self.tmp.name),self.config)
        self.assertFalse(orphans[0].exists());self.assertNotIn('payload',cx.load_record(Path(self.tmp.name),result['draftId']))

    def test_malformed_owned_cache_is_age_bounded_and_fresh_fragments_preserved(self):
        result=self.prepare();path=cx.cache_path(Path(self.tmp.name),result['draftId'])
        broken=path.read_text()[:-1];path.write_text(broken)
        cx.cleanup_expired(Path(self.tmp.name),self.config);self.assertTrue(path.exists())
        old=datetime.now(timezone.utc).timestamp()-cx.CACHE_MAX_AGE_SECONDS-2
        os.utime(path,(old,old))
        temp=path.with_suffix('.tmp-'+'b'*32);temp.write_text(broken);os.utime(temp,(old,old))
        unrelated=path.parent/'resident-note.txt';unrelated.write_text('preserve');os.utime(unrelated,(old,old))
        cx.cleanup_expired(Path(self.tmp.name),self.config)
        self.assertFalse(path.exists());self.assertFalse(temp.exists());self.assertTrue(unrelated.exists())
        self.transport.assert_not_called()

    def test_cleanup_preserves_unexpired_temp_and_never_follows_temp_symlink(self):
        result=self.prepare();record=cx.load_record(Path(self.tmp.name),result['draftId']);path=cx.cache_path(Path(self.tmp.name),result['draftId'])
        temp=path.with_suffix('.tmp-'+'c'*32);temp.write_text(cx.canonical(record));temp.chmod(0o600)
        link=path.with_suffix('.tmp-'+'d'*32);target=Path(self.tmp.name,'private-unrelated');target.write_text('preserve');link.symlink_to(target)
        cx.cleanup_expired(Path(self.tmp.name),self.config)
        self.assertTrue(temp.exists());self.assertTrue(link.is_symlink());self.assertEqual(target.read_text(),'preserve')
        self.transport.assert_not_called()

    def test_decline_sync_failure_stays_terminal_then_next_turn_retries_restrictive_marker(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected');self.transport.side_effect=TimeoutError()
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'contextsling_declined')
        record=cx.load_record(Path(self.tmp.name),result['draftId']);self.assertTrue(record['pendingDecline']);self.assertNotIn('payload',record)
        self.transport.reset_mock();self.transport.side_effect=None
        self.transport.return_value={'kind':'contextsling.write','state':'declined','operation':result['operation'],'draftId':result['draftId']}
        with patch.object(cx,'approval_modules',return_value=ap): bridge.cleanup_contextsling_turn()
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId'],'declined':True})
        self.assertFalse(cx.load_record(Path(self.tmp.name),result['draftId']).get('pendingDecline'))
        ap.propose.assert_called_once();ap.start.assert_not_called()

    def test_model_cannot_supply_decline_marker_and_foreign_owner_cannot_sync(self):
        result=self.prepare();self.next_turn()
        self.assertEqual(self.call({'operation':result['operation'],'draftId':result['draftId'],'declined':True})['error'],'invalid_arguments')
        record=cx.load_record(Path(self.tmp.name),result['draftId']);record['pendingDecline']=True
        cx.terminal(Path(self.tmp.name),result['draftId'],record,'contextsling_declined')
        cx.sync_declines(Path(self.tmp.name),{**self.config,'ownerTelegramId':'99'},self.transport)
        self.transport.assert_not_called()

    def test_prepare_app_error_codes_have_closed_staging_copy(self):
        self.enable()
        for code in cx.PREPARE_ERRORS:
            self.transport.return_value={'error':code,'detail':'hostile secret'}
            out=self.call({'operation':'contextsling.prepare','action':'publish','file':{'name':'x.md','lines':['hi'],'finalNewline':False}})
            self.assertEqual(out['data']['error'],code);self.assertNotIn('hostile',json.dumps(out));self.assertNotIn('reconnect',json.dumps(out))

    def test_missing_app_row_after_two_days_settles_only_cancellation_without_success_claim(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected');self.transport.side_effect=TimeoutError()
        with patch.object(cx,'approval_modules',return_value=ap): self.assertEqual(self.confirm(result)['error'],'contextsling_declined')
        path=cx.cache_path(Path(self.tmp.name),result['draftId'])
        two_days_ago=datetime.now(timezone.utc).timestamp()-2*24*3600
        os.utime(path,(two_days_ago,two_days_ago))
        self.transport.reset_mock();self.transport.side_effect=None;self.transport.return_value={'error':'contextsling_expired'}
        bridge.cleanup_contextsling_turn()
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId'],'declined':True})
        record=cx.load_record(Path(self.tmp.name),result['draftId'])
        self.assertFalse(record.get('pendingDecline'));self.assertNotIn('payload',record);self.assertEqual(record['terminal'],'contextsling_declined')
        self.transport.reset_mock();bridge.cleanup_contextsling_turn()
        self.assertEqual(self.confirm(result)['error'],'contextsling_declined');self.transport.assert_not_called()
        ap.propose.assert_called_once();ap.start.assert_not_called()
        # Generic publication/recovery handling still sees expiry as an error, never success.
        out=cx.response(Path(self.tmp.name),result['operation'],{'error':'contextsling_expired'},record,result['draftId'])
        self.assertEqual(out['error'],'contextsling_expired');self.assertNotIn('state',out)

    def test_cancellation_unknown_errors_or_nonclosed_expiry_keep_retry_marker(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected');self.transport.side_effect=TimeoutError()
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        self.transport.side_effect=None
        for result_error in ({'error':'contextsling_unconfirmed'},{'error':'contextsling_connection_changed'},{'error':'unknown'},{'error':'contextsling_expired','detail':'arbitrary'},{}):
            self.transport.return_value=result_error
            cx.sync_declines(Path(self.tmp.name),self.config,self.transport)
            self.assertTrue(cx.load_record(Path(self.tmp.name),result['draftId'])['pendingDecline'])
        self.transport.side_effect=TimeoutError()
        cx.sync_declines(Path(self.tmp.name),self.config,self.transport)
        self.assertTrue(cx.load_record(Path(self.tmp.name),result['draftId'])['pendingDecline'])
        ap.propose.assert_called_once();ap.start.assert_not_called()

    def test_hook_shared_config_refuses_bad_network_credentials_but_keeps_local_cleanup(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected');self.transport.side_effect=TimeoutError()
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        self.transport.side_effect=None;self.transport.reset_mock()
        body_id='b'*22
        base_record={'owner':self.config['ownerTelegramId'],'origin':self.config['origin'],'session':'old','message':'1',
                     'operation':result['operation'],'draftId':body_id,'payload':copy.deepcopy(result['approvalPayload'])}
        base_record['payload']['preview']['draftId']=body_id
        base_record['payloadHash']=hashlib.sha256(cx.canonical(base_record['payload']).encode()).hexdigest()
        bad_configs=[{'origin':'http://example.invalid'}, {'origin':'unknown://example.invalid'}, {'origin':'https://'},
                     {'origin':'https://user:password@example.invalid'}, {'origin':'https://example.invalid/path'},
                     {'origin':'https://example.invalid?credential=bad'}, {'token':'malformed'},
                     {'expiresAt':'2000-01-01T00:00:00.000Z'}, {'ownerTelegramId':'99'}, {'expiresAt':'not-a-date'}]
        path=Path(self.tmp.name,'village-bridge.json')
        for mutation in bad_configs:
            with self.subTest(mutation=mutation):
                cx.write_record(cx.cache_path(Path(self.tmp.name),body_id),copy.deepcopy(base_record))
                path.write_text(json.dumps({**self.config,**mutation}))
                self.transport.reset_mock()
                with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules') as modules:
                    bridge.cleanup_contextsling_turn()
                self.transport.assert_not_called();modules.assert_not_called()
                self.assertNotIn('payload',cx.load_record(Path(self.tmp.name),body_id))
                self.assertTrue(cx.load_record(Path(self.tmp.name),result['draftId'])['pendingDecline'])
                self.assertIn('error',self.call({'operation':'contextsling.usage'}));self.transport.assert_not_called()
        cx.write_record(cx.cache_path(Path(self.tmp.name),body_id),copy.deepcopy(base_record))
        path.write_text('partial malformed configuration')
        with patch.object(cx,'expired',return_value=True),patch.object(cx,'approval_modules') as modules:
            bridge.cleanup_contextsling_turn()
        self.assertNotIn('payload',cx.load_record(Path(self.tmp.name),body_id));modules.assert_not_called();self.transport.assert_not_called()
        # Refresh to an ordinarily valid bridge credential and resume only cancellation.
        path.write_text(json.dumps(self.config))
        self.transport.return_value={'kind':'contextsling.write','state':'declined','operation':result['operation'],'draftId':result['draftId']}
        bridge.cleanup_contextsling_turn()
        self.transport.assert_called_once_with(self.config,{'operation':result['operation'],'draftId':result['draftId'],'declined':True})
        self.assertFalse(cx.load_record(Path(self.tmp.name),result['draftId']).get('pendingDecline'))

    def test_decline_sync_requires_current_install_even_for_saved_terminal_task(self):
        result=self.prepare();self.next_turn();ap=self.daemon(status='rejected');self.transport.side_effect=TimeoutError()
        with patch.object(cx,'approval_modules',return_value=ap): self.confirm(result)
        Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[]}))
        self.transport.side_effect=None;self.transport.reset_mock()
        cx.sync_declines(Path(self.tmp.name),self.config,self.transport)
        self.transport.assert_not_called()
        self.assertTrue(cx.load_record(Path(self.tmp.name),result['draftId'])['pendingDecline'])
        self.assertNotIn('payload',cx.load_record(Path(self.tmp.name),result['draftId']))

    def test_uninstall_during_manual_authorization_refuses_before_app_dispatch(self):
        result=self.prepare();self.next_turn();ap=self.daemon()
        def uninstall_during_start(*args):
            Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[]}))
            return answer(ok=True,authorization='grant')
        ap.start.side_effect=uninstall_during_start
        with patch.object(cx,'approval_modules',return_value=ap): out=self.confirm(result)
        self.assertEqual(out.get('error'),'mini_app_not_installed')
        self.transport.assert_not_called();ap.start.assert_called_once()
        record=cx.load_record(Path(self.tmp.name),result['draftId'])
        self.assertEqual(record['terminal'],'mini_app_not_installed');self.assertNotIn('payload',record)

if __name__ == '__main__': unittest.main()
