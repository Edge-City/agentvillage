import contextvars
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import hashlib
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('village_bridge',Path(__file__).parents[1]/'__init__.py')
bridge=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=bridge;SPEC.loader.exec_module(bridge)
mini=sys.modules['village_bridge._mini_apps']
real_transport=bridge.transport
class TransportTest(unittest.TestCase):
 def test_oversized_result_is_refused_without_partial_data(self):
  response=unittest.mock.MagicMock()
  response.__enter__.return_value=response
  response.read.return_value=b'x'*262145
  opener=unittest.mock.Mock();opener.open.return_value=response
  with patch.object(bridge,'build_opener',return_value=opener):
   result=real_transport({'origin':'https://agents.edgecity.live','token':'not-logged'},{'operation':'mini-app.read'})
  self.assertEqual(result['error'],'response_too_large')
  self.assertIn('Narrow',result['instruction']);self.assertNotIn('data',result)
  response.read.assert_called_once_with(262145)
 def test_send_timeout_leaves_room_for_app_and_cp_authority_checks(self):
  response=unittest.mock.MagicMock();response.__enter__.return_value=response;response.read.return_value=b'{}'
  opener=unittest.mock.Mock();opener.open.return_value=response
  with patch.object(bridge,'build_opener',return_value=opener):
   for operation,timeout in [('gold-stars.send',60),('gold-stars.status',25),('mini-app.read',25)]:
    real_transport({'origin':'https://agents.edgecity.live','token':'not-logged'},{'operation':operation})
    self.assertEqual(opener.open.call_args.kwargs['timeout'],timeout)

class BridgeTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.config={'version':1,'origin':'https://agents.edgecity.live','token':'avb_'+'x'*43,'ownerTelegramId':'42','expiresAt':'2099-01-01T00:00:00Z'}
  Path(self.tmp.name,'village-bridge.json').write_text(json.dumps(self.config))
  Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[{'id':'gold-stars',**mini.GOLD_STARS},{'id':'dizko','version':'1.0.0','skills':['dizko'],'operations':['mini-app.read']}]}))
  self.unset=object();self.sc=types.ModuleType('gateway.session_context');self.sc._UNSET=self.unset
  self.sc._VAR_MAP={}
  values={'HERMES_SESSION_PLATFORM':'telegram','HERMES_SESSION_CHAT_TYPE':'private','HERMES_SESSION_CHAT_ID':'42','HERMES_SESSION_USER_ID':'42','HERMES_SESSION_KEY':'telegram:42','HERMES_SESSION_MESSAGE_ID':'9'}
  for k,v in values.items():
   var=contextvars.ContextVar(k,default=self.unset);var.set(v);self.sc._VAR_MAP[k]=var
  cron=contextvars.ContextVar('cron',default=self.unset);cron.set('');self.sc._VAR_MAP['HERMES_CRON_SESSION']=cron
  gateway=types.ModuleType('gateway');gateway.session_context=self.sc
  delegation=types.ModuleType('agent.delegation_context');delegation.is_delegated_child_context=lambda:False
  self.delegation=delegation
  self.patches=[patch.dict(os.environ,{'HERMES_HOME':self.tmp.name}),patch.dict(sys.modules,{'gateway':gateway,'gateway.session_context':self.sc,'agent.delegation_context':delegation}),patch.object(bridge,'transport',return_value={'ok':True})]
  for p in self.patches:p.start();self.addCleanup(p.stop)
  self.transport=bridge.transport
 def call(self,args=None):return json.loads(bridge.handle(args or {'operation':'gold-stars.quota'}))
 def test_owner_read_has_no_actor_argument(self):
  self.assertIn('data',self.call());self.transport.assert_called_once_with(self.config,{'operation':'gold-stars.quota'})
 def test_other_contexts_are_refused_without_network(self):
  for key,value in [('PLATFORM','cli'),('CHAT_TYPE','group'),('CHAT_ID','-12'),('USER_ID','99'),('MESSAGE_ID','')]:
   with self.subTest(key=key):
    var=self.sc._VAR_MAP['HERMES_SESSION_'+key];token=var.set(value)
    self.assertEqual(self.call()['error'],'private_owner_chat_required');var.reset(token)
  self.sc._VAR_MAP['HERMES_CRON_SESSION'].set('job');self.assertEqual(self.call()['error'],'private_owner_chat_required')
  self.transport.assert_not_called()
 def test_unbound_context_ignores_forged_environment(self):
  self.sc._VAR_MAP['HERMES_SESSION_USER_ID'].set(self.unset)
  with patch.dict(os.environ,{'HERMES_SESSION_USER_ID':'42'}):self.assertEqual(self.call()['error'],'private_owner_chat_required')
  self.transport.assert_not_called()
 def test_child_is_refused(self):
  self.delegation.is_delegated_child_context=lambda:True
  self.assertEqual(self.call()['error'],'private_owner_chat_required');self.transport.assert_not_called()
 def test_different_paired_owner_refused(self):
  self.sc._VAR_MAP['HERMES_SESSION_USER_ID'].set('99');self.sc._VAR_MAP['HERMES_SESSION_CHAT_ID'].set('99')
  self.assertEqual(self.call()['error'],'private_owner_chat_required');self.transport.assert_not_called()
 def test_uninstalled_and_undeclared_operations_refuse_network(self):
  for operation in ['rolodex.meeting','skylight.status']:
   self.assertEqual(self.call({'operation':operation})['error'],'mini_app_not_installed')
  Path(self.tmp.name,'mini-apps.json').unlink()
  self.assertEqual(self.call()['error'],'mini_app_not_installed')
  self.transport.assert_not_called()
 def test_unknown_actions_and_actor_injection_refused(self):
  for args in [{'operation':'gold-stars.send'},{'operation':'gold-stars.quota','humanId':'other'}, {'operation':'gold-stars.prepare','attendeeId':'bad','note':'x','visibility':'named'}]:self.assertEqual(self.call(args)['error'],'village_unavailable')
  self.transport.assert_not_called()
 def test_no_secret_in_error(self):
  self.transport.side_effect=RuntimeError(self.config['token']);self.assertNotIn(self.config['token'],json.dumps(self.call()))
 def test_star_preview_turn_id_is_stable_and_changes_on_new_reply(self):
  args={'operation':'gold-stars.prepare','attendeeId':'550e8400-e29b-41d4-a716-446655440000','note':'Thank you','visibility':'anonymous'}
  self.call(args);first=self.transport.call_args.args[1]
  self.assertEqual(first['visibility'],'anonymous');self.assertEqual(first['note'],'Thank you')
  self.call(args);self.assertEqual(first['turnId'],self.transport.call_args.args[1]['turnId'])
  self.sc._VAR_MAP['HERMES_SESSION_MESSAGE_ID'].set('10')
  self.call(args);self.assertNotEqual(first['turnId'],self.transport.call_args.args[1]['turnId'])
 def test_send_fetches_backend_preview_and_refuses_without_authority(self):
  draft='550e8400-e29b-41d4-a716-446655440000'
  preview={'appId':'gold-stars','draftId':draft,'attendeeId':draft,'recipientName':'Someone','note':'Exact note','visibility':'named'}
  self.transport.return_value={'status':'pending','approvalPayload':preview}
  with patch.object(mini,'approval_modules',side_effect=ValueError('unavailable')):
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':draft})['error'],'village_unavailable')
  self.transport.assert_called_once_with(self.config,{'operation':'gold-stars.status','draftId':draft})
 def test_send_submits_identical_daemon_payload_and_rechecks_opt_out(self):
  draft='550e8400-e29b-41d4-a716-446655440000'
  preview={'appId':'gold-stars','draftId':draft,'attendeeId':draft,'recipientName':'Someone','note':'Exact note','visibility':'named'}
  authorization={'taskId':'propose:'+'a'*32,'payloadHash':'registered','payload':{'appId':'gold-stars','operation':'gold-stars.send','preview':preview}}
  self.transport.side_effect=[{'status':'pending','approvalPayload':preview},{'status':'sent'}]
  with patch.object(bridge,'authorize_send',return_value=(authorization,None)) as approve:
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':draft})['data']['status'],'sent')
   approve.assert_called_once_with(preview,draft)
  sent=self.transport.call_args.args[1]
  self.assertEqual(sent['approval'],authorization);self.assertEqual(sent['draftId'],draft)
  self.transport.reset_mock();self.transport.side_effect=None
  self.transport.return_value={'status':'pending','approvalPayload':preview}
  def revoke(*args):
   Path(self.tmp.name,'mini-apps.json').write_text('{"version":1,"apps":[]}')
   return authorization,None
  with patch.object(bridge,'authorize_send',side_effect=revoke):
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':draft})['error'],'mini_app_not_installed')
  self.transport.assert_called_once_with(self.config,{'operation':'gold-stars.status','draftId':draft})
 def test_uncertain_send_replays_same_immutable_draft_proof_without_fresh_start(self):
  draft='550e8400-e29b-41d4-a716-446655440000'
  preview={'appId':'gold-stars','draftId':draft,'attendeeId':draft,'recipientName':'Someone','note':'Exact note','visibility':'named'}
  ap=unittest.mock.Mock()
  def propose(cls,key,summary,payload):
   state='executed' if ap.start.called else 'granted'
   return types.SimpleNamespace(ok=True,doc={'task':'propose:'+'a'*32,'decision':'requested','state':state,'payload_hash':hashlib.sha256(payload.encode()).hexdigest()})
  ap.propose.side_effect=propose
  ap.wait.return_value=types.SimpleNamespace(exit_code=0,status='granted')
  ap.start.return_value=types.SimpleNamespace(ok=True,doc={'authorization':'grant'})
  self.transport.side_effect=[{'status':'pending','approvalPayload':preview},TimeoutError(),{'status':'pending','approvalPayload':preview},{'status':'sent'}]
  with patch.object(mini,'approval_modules',return_value=ap):
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':draft})['error'],'village_unavailable')
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':draft})['data']['status'],'sent')
  requests=[call.args[1] for call in self.transport.call_args_list]
  self.assertEqual([request['operation'] for request in requests],['gold-stars.status','gold-stars.send','gold-stars.status','gold-stars.send'])
  self.assertTrue(all(request['draftId']==draft for request in requests))
  self.assertEqual(requests[1],requests[3])
  self.assertEqual(ap.propose.call_args_list[0],ap.propose.call_args_list[1])
  ap.wait.assert_called_once_with('propose:'+'a'*32)
  ap.start.assert_called_once()
 def test_sent_receipt_does_not_request_another_approval(self):
  self.transport.return_value={'status':'sent'}
  with patch.object(bridge,'authorize_send') as approve:
   self.assertEqual(self.call({'operation':'gold-stars.send','draftId':'550e8400-e29b-41d4-a716-446655440000'})['data']['status'],'sent')
   approve.assert_not_called()
 def test_public_read_transport_checks_shape_and_installed_app(self):
  args={'operation':'mini-app.read','appId':'dizko','tool':'list_cities','arguments':{}}
  self.assertIn('data',self.call(args));self.transport.assert_called_once_with(self.config,args)
  self.transport.reset_mock()
  for bad in [{**args,'tool':'../../purchase'},{**args,'url':'https://evil.invalid'},{**args,'appId':'other'}]:
   self.assertIn('error',self.call(bad))
  self.transport.assert_not_called()
 def test_reviewed_public_read_transport_is_not_hardcoded_to_one_app(self):
  Path(self.tmp.name,'mini-apps.json').write_text(json.dumps({'version':1,'apps':[{'id':'public-guide','version':'1.0.0','skills':['public-guide'],'operations':['mini-app.read']}]}))
  args={'operation':'mini-app.read','appId':'public-guide','tool':'list_places','arguments':{}}
  self.assertIn('data',self.call(args));self.transport.assert_called_once_with(self.config,args)
  # CP/app server remains authoritative for reviewed app/tool/schema; this layer supplies no URL.
 def test_star_fields_are_exact_and_cannot_override_confirmation_origin(self):
  base={'operation':'gold-stars.prepare','attendeeId':'550e8400-e29b-41d4-a716-446655440000','note':'Thanks','visibility':'named'}
  for args in [{**base,'turnId':'forged'},{**base,'visibility':'private'},{**base,'note':'x'*501},
               {**base,'confirmed':True},{'operation':'gold-stars.send','draftId':base['attendeeId'],'turnId':'forged'},
               {'operation':'gold-stars.send','draftId':base['attendeeId'],'note':'changed'}]:
   self.assertEqual(self.call(args)['error'],'village_unavailable')
  self.transport.assert_not_called()
 def test_status_and_cancel_use_only_exact_draft_id_and_star_calls_refuse_cron(self):
  for op in ['gold-stars.status','gold-stars.cancel']:
   args={'operation':op,'draftId':'550e8400-e29b-41d4-a716-446655440000'}
   self.call(args);self.assertEqual(self.transport.call_args.args[1],args)
  self.transport.reset_mock()
  self.sc._VAR_MAP['HERMES_CRON_SESSION'].set('evening')
  for op in ['gold-stars.prepare','gold-stars.send','gold-stars.status','gold-stars.cancel']:
   self.assertEqual(self.call({'operation':op})['error'],'private_owner_chat_required')
  self.transport.assert_not_called()
 def test_registration_idempotent(self):
  with patch.object(bridge,'_REGISTERED',False):
   ctx=types.SimpleNamespace(register_tool=unittest.mock.Mock());bridge.register(ctx);bridge.register(ctx);self.assertEqual(ctx.register_tool.call_count,1)
if __name__=='__main__':unittest.main()
