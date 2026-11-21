"""Offline authority/boundary regressions; no Hermes, daemon, model or network."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("mini_apps_test", Path(__file__).parents[1] / "_mini_apps.py")
mini = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mini)


def answer(doc=None, code=0):
    doc = doc or {}
    return types.SimpleNamespace(ok=code == 0 and doc.get("ok") is True, doc=doc, exit_code=code, status=doc.get("status"))


class ApprovalTest(unittest.TestCase):
    def setUp(self):
        self.draft = "550e8400-e29b-41d4-a716-446655440000"
        self.preview = dict(appId="gold-stars", draftId=self.draft, attendeeId=self.draft,
                            recipientName="Naman", note="Exact note: café", visibility="anonymous")
        self.ap = Mock()
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="granted", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        self.ap.wait.return_value = answer(dict(status="granted"))
        self.ap.start.return_value = answer(dict(ok=True, authorization="grant"))
        p = patch.object(mini, "approval_modules", return_value=self.ap)
        p.start()
        self.addCleanup(p.stop)

    def test_exact_preview_passed_to_propose_and_start(self):
        grant, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        args = self.ap.propose.call_args.args
        # B-133: the member class, and the key the daemon requires to start with "<class>:".
        self.assertEqual(args[0], "marketplace.app.action.gold-stars.send")
        self.assertEqual(args[1], "marketplace.app.action.gold-stars.send:" + self.draft)
        self.assertEqual(json.loads(args[3]), grant["payload"])
        self.assertEqual(grant["payload"]["preview"], self.preview)
        self.assertEqual(self.ap.start.call_args.args, ("propose:" + "a" * 32, args[1], args[3]))
        self.ap.wait.assert_called_once_with("propose:" + "a" * 32)

    def test_malformed_daemon_task_ids_never_reach_wait_or_start(self):
        for task in ("propose:123", "a" * 32, self.draft, "propose:" + "A" * 32, "propose:" + "a" * 32 + "\n"):
            self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task=task, decision="requested", state="granted", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_pending_rejected_revoked_expired_never_start(self):
        for status in ("requested", "rejected", "revoked", "expired", "executed", "void"):
            self.ap.wait.return_value = answer(dict(status=status), 7)
            grant, refusal = mini.authorize_send(self.preview, self.draft)
            self.assertIsNone(grant)
            self.assertEqual(refusal["error"], "approval_required")
        self.ap.start.assert_not_called()

    def autonomous(self, **extra):
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", state=None, seq=None, payload_hash=hashlib.sha256(payload.encode()).hexdigest(), **extra))

    def test_policy_autonomy_starts_as_policy_without_waiting_for_a_grant(self):
        # HOT-01 (B-032): the attested policy authorizes the send; core records the start as the
        # policy's, and the control plane re-reads that start from the daemon's log (its proof).
        self.autonomous()
        self.ap.start.return_value = answer(dict(ok=True, authorization="policy"))
        proof, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        args = self.ap.propose.call_args.args
        self.assertEqual(proof, {"taskId": "propose:" + "a" * 32, "payloadHash": hashlib.sha256(args[3].encode()).hexdigest(), "payload": json.loads(args[3])})
        self.assertEqual(self.ap.start.call_args.args, ("propose:" + "a" * 32, args[1], args[3]))
        self.ap.wait.assert_not_called()

    def test_policy_autonomy_needs_a_policy_start(self):
        # A start that claims a grant on the policy path, a refused start, or a stray request state is refused.
        for start in (answer(dict(ok=True, authorization="grant")), answer(dict(ok=False), 1), answer(dict(ok=True))):
            self.autonomous()
            self.ap.start.return_value = start
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_not_started")
        self.ap.start.reset_mock()
        for state in ("requested", "granted", "rejected"):
            self.ap.propose.side_effect = lambda cls, key, summary, payload, state=state: answer(dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", state=state, payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.start.assert_not_called()
        self.ap.wait.assert_not_called()

    def test_policy_autonomy_executed_replays_the_same_proof(self):
        self.autonomous()
        self.ap.start.return_value = answer(dict(ok=True, authorization="policy"))
        original, _ = mini.authorize_send(self.preview, self.draft)
        self.ap.start.reset_mock()
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", state="executed", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        replay, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        self.assertEqual(replay, original)
        self.ap.start.assert_not_called()

    def test_supervised_and_unknown_decisions_refused(self):
        for decision in ("supervised", "granted", None, ""):
            self.ap.propose.side_effect = lambda cls, key, summary, payload, decision=decision: answer(dict(ok=True, task="propose:" + "a" * 32, decision=decision, payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    # ov#370 round 1 (review-b S1): the autonomous path's matrix, each cell fail-closed.
    def test_policy_autonomy_refuses_look_alike_authorizations_and_a_start_not_ok(self):
        for doc in (dict(ok=True, authorization="Policy"), dict(ok=True, authorization="policy "), dict(ok=True, authorization=" policy"),
                    dict(ok=True, authorization="policy;human"), dict(ok=True, authorization="POLICY"), dict(ok=True, authorization=1),
                    dict(ok=True, authorization=["policy"]), dict(ok=True, authorization={"policy": True}), dict(ok=True, authorization=None),
                    dict(ok="true", authorization="policy"), dict(ok=1, authorization="policy"), dict(authorization="policy")):
            self.autonomous()
            self.ap.start.return_value = answer(doc)
            self.assertEqual([doc, mini.authorize_send(self.preview, self.draft)], [doc, (None, {"error": "approval_not_started"})])
        # exit code not 0 with an otherwise perfect doc
        self.autonomous()
        self.ap.start.return_value = answer(dict(ok=True, authorization="policy"), 1)
        self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_not_started")
        self.ap.wait.assert_not_called()

    def test_policy_autonomy_start_that_raises_or_times_out_propagates(self):
        # authorize_send never swallows a daemon failure on the autonomous path; handle() turns it into
        # village_unavailable with no send (test_bridge.test_autonomous_start_failure_sends_nothing).
        for error in (TimeoutError(), RuntimeError("approval_unavailable"), ValueError("transport")):
            self.autonomous()
            self.ap.start.side_effect = error
            with self.assertRaises(type(error)):
                mini.authorize_send(self.preview, self.draft)
            self.ap.start.side_effect = None
        self.ap.wait.assert_not_called()

    def test_policy_autonomy_refuses_hash_mismatch_bad_task_and_a_refused_propose(self):
        def answered(**doc):
            base = dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", state=None)
            base.update(doc)
            return lambda cls, key, summary, payload: answer({**base, **({"payload_hash": hashlib.sha256(payload.encode()).hexdigest()} if "payload_hash" not in doc else {})})
        for side in (answered(payload_hash="wrong"), answered(payload_hash=None), answered(task="propose:123"), answered(task="propose:" + "A" * 32),
                     answered(task=None), answered(ok=False), lambda *a: answer(dict(ok=True, decision="autonomous"), 1)):
            self.ap.propose.side_effect = side
            self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.start.assert_not_called()
        self.ap.wait.assert_not_called()

    def test_policy_autonomy_refuses_lapsed_or_withdrawn_states(self):
        for state in ("expired", "withdrawn", "revoked", "void", "", "Executed", 0):
            self.ap.propose.side_effect = lambda cls, key, summary, payload, state=state: answer(dict(ok=True, task="propose:" + "a" * 32, decision="autonomous", state=state, payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual([state, mini.authorize_send(self.preview, self.draft)[1]["error"]], [state, "approval_refused"])
        self.ap.start.assert_not_called()
        self.ap.wait.assert_not_called()

    def test_look_alike_decisions_refused(self):
        for decision in ("Autonomous", "autonomous ", " autonomous", "AUTONOMOUS", "requested ", True, 1, ["autonomous"]):
            self.ap.propose.side_effect = lambda cls, key, summary, payload, decision=decision: answer(dict(ok=True, task="propose:" + "a" * 32, decision=decision, state=None, payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
            self.assertEqual([decision, mini.authorize_send(self.preview, self.draft)[1]["error"]], [decision, "approval_refused"])
        self.ap.start.assert_not_called()
        self.ap.wait.assert_not_called()

    def test_approval_required_points_at_the_agent_approval_bot_and_the_same_draft(self):
        self.ap.wait.return_value = answer(dict(status="requested"), 6)
        refusal = mini.authorize_send(self.preview, self.draft)[1]
        self.assertEqual(refusal, {"error": "approval_required", "instruction": mini.APPROVE_IN_BOT})
        self.assertIn("approvals bot", mini.APPROVE_IN_BOT)
        self.assertIn("SAME draftId", mini.APPROVE_IN_BOT)

    def test_pending_instructions_include_public_approvals_chat(self):
        self.assertEqual(mini.APPROVALS_CHAT_URL, "https://t.me/AgentVillageApprovalsBot")
        for instruction in (mini.APPROVE_IN_BOT, mini.ORDER_APPROVE_IN_BOT, mini.ORDER_PLACED_ON_APPROVAL):
            with self.subTest(instruction=instruction):
                self.assertIn('Open approvals chat: ' + mini.APPROVALS_CHAT_URL, instruction)
                self.assertIn('SAME draftId', instruction)
                self.assertNotIn('?start=', instruction)
                self.assertNotIn('t.me/c/', instruction)
        for instruction in (mini.ORDER_CARD_NOT_RAISED, mini.ORDER_APPROVAL_REFUSED,
                            mini.ORDER_APPROVAL_UNAVAILABLE, mini.ORDER_CARD_CLOSED):
            self.assertNotIn(mini.APPROVALS_CHAT_URL, instruction)

    def test_changed_payload_hash_refused(self):
        self.ap.propose.side_effect = lambda *args: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", payload_hash="wrong"))
        self.assertIsNone(mini.authorize_send(self.preview, self.draft)[0])
        self.ap.start.assert_not_called()

    def test_wrong_start_authorization_refused(self):
        # A requested (ask-first) proposal must spend the human's grant; a policy start is refused there.
        self.ap.start.return_value = answer(dict(ok=True, authorization="policy"))
        self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_not_started")

    def test_executed_proposal_reconstructs_identical_proof_without_another_start(self):
        original, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        proposed = self.ap.propose.call_args
        self.ap.wait.reset_mock()
        self.ap.start.reset_mock()
        self.ap.propose.side_effect = lambda cls, key, summary, payload: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="executed", payload_hash=hashlib.sha256(payload.encode()).hexdigest()))
        replay, refusal = mini.authorize_send(self.preview, self.draft)
        self.assertIsNone(refusal)
        self.assertEqual(replay, original)
        self.assertEqual(self.ap.propose.call_args, proposed)
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_executed_proposal_with_mismatched_hash_cannot_replay(self):
        self.ap.propose.side_effect = lambda *args: answer(dict(ok=True, task="propose:" + "a" * 32, decision="requested", state="executed", payload_hash="wrong"))
        self.assertEqual(mini.authorize_send(self.preview, self.draft)[1]["error"], "approval_refused")
        self.ap.wait.assert_not_called()
        self.ap.start.assert_not_called()

    def test_send_class_and_key_are_the_member_class_on_both_paths(self):
        # B-133: requested and autonomous both propose exactly SEND_CLASS with the key derived from it;
        # the start reuses that same key byte for byte (same-draft recovery depends on it).
        self.assertEqual(mini.SEND_CLASS, "marketplace.app.action.gold-stars.send")
        self.assertEqual(mini.send_key(self.draft), "marketplace.app.action.gold-stars.send:" + self.draft)
        for decision, authorization in (("requested", "grant"), ("autonomous", "policy")):
            self.ap.reset_mock()
            if decision == "autonomous":
                self.autonomous()
            self.ap.start.return_value = answer(dict(ok=True, authorization=authorization))
            proof, refusal = mini.authorize_send(self.preview, self.draft)
            self.assertIsNone(refusal)
            cls, key, _, held = self.ap.propose.call_args.args
            self.assertEqual((cls, key), ("marketplace.app.action.gold-stars.send", "marketplace.app.action.gold-stars.send:" + self.draft))
            self.assertTrue(key.startswith(cls + ":"))
            self.assertEqual(self.ap.start.call_args.args, (proof["taskId"], key, held))

    def test_send_class_is_the_templates_autonomous_member_row_and_the_parent_stays_manual(self):
        # B-133: the class this bridge proposes is a row of the shipped resident policy template, autonomous
        # with agent_may_request (without the row the daemon refuses it as class-not-agent-requestable);
        # the parent marketplace.app.action row stays manual for every other installed app.
        text = (Path(__file__).parents[3] / "skills" / "approval" / "templates" / "APPROVAL.md").read_text(encoding="utf-8")
        start = text.index("```yaml approval-policy\n")
        block = text[start:text.index("\n```", start + 1)]
        classes = block[block.index("\nclasses:\n"):]
        rows = {m.group(1): m.group(2) for m in re.finditer(r"^  ([a-z][a-z0-9.*-]*):\s+(\{[^}]*\})", classes, re.M)}
        self.assertEqual(rows[mini.SEND_CLASS], "{ autonomy: autonomous, agent_may_request: true }")
        self.assertEqual(rows["marketplace.app.action"], "{ autonomy: manual, agent_may_request: true }")
        self.assertFalse([name for name in rows if name != mini.SEND_CLASS and name.startswith("marketplace.app.action.")])

    def test_preview_from_another_draft_and_extra_model_flags_refused(self):
        for preview in ({**self.preview, "draftId": "other"}, {**self.preview, "approved": True}, None):
            self.assertIsNone(mini.authorize_send(preview, self.draft)[0])
        self.ap.propose.assert_not_called()


class ProjectionTest(unittest.TestCase):
    def test_only_exact_reviewed_projection_and_no_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            app = {"id": "gold-stars", **mini.GOLD_STARS}
            doc = {"version": 1, "apps": [app]}
            path.write_text(json.dumps(doc))
            self.assertTrue(mini.installed(home, "gold-stars", "gold-stars.send"))
            # BRIDGE-RESTORE: the reviewed entry carries ov#300's two native operations.
            self.assertTrue(mini.installed(home, "gold-stars", "rolodex.meeting"))
            self.assertTrue(mini.installed(home, "gold-stars", "skylight.status"))
            self.assertFalse(mini.installed(home, "dizko", "mini-app.read"))
            self.assertFalse(mini.installed(home, "dizko", "rolodex.meeting"))
            # The pre-restore entry stays valid for its own six operations only.
            previous = {"id": "gold-stars", **mini.GOLD_STARS_PREVIOUS}
            path.write_text(json.dumps({"version": 1, "apps": [previous]}))
            self.assertTrue(mini.installed(home, "gold-stars", "gold-stars.send"))
            self.assertFalse(mini.installed(home, "gold-stars", "rolodex.meeting"))
            self.assertFalse(mini.installed(home, "gold-stars", "skylight.status"))
            ops = app["operations"]
            for apps in ([{**app, "operations": ops + ["rolodex.delete"]}], [{**app, "operations": [o for o in ops if o != "skylight.status"]}],
                         [{**app, "operations": ops[::-1]}], [{**previous, "operations": previous["operations"] + ["rolodex.meeting"]}],
                         [{**app, "skills": ["gold-stars", "rolodex"]}], [app, previous], [app, app], [], [{**app, "version": "future"}]):
                path.write_text(json.dumps({"version": 1, "apps": apps}))
                self.assertFalse(mini.installed(home, "gold-stars", "gold-stars.send"))
            path.unlink()
            other = home / "other.json"
            other.write_text(json.dumps(doc))
            path.symlink_to(other)
            self.assertFalse(mini.installed(home, "gold-stars", "gold-stars.send"))

    def test_rolodex_person_entries_9_8_6_each_carry_their_own_operations(self):
        # ROLODEX.PERSON (rc42): the 9-op entry appends rolodex.person LAST; the 8-op (ov#350, the CP's
        # current entry) and 6-op (ov#343) entries stay accepted, each for exactly its own operations.
        nine = mini.GOLD_STARS["operations"]
        eight = mini.GOLD_STARS_RESTORED["operations"]
        six = mini.GOLD_STARS_PREVIOUS["operations"]
        self.assertEqual(nine, eight + ["rolodex.person"])
        self.assertEqual(eight, six + ["rolodex.meeting", "skylight.status"])
        self.assertEqual(mini.GOLD_STARS_ACCEPTED, (mini.GOLD_STARS, mini.GOLD_STARS_RESTORED, mini.GOLD_STARS_PREVIOUS))
        for entry in mini.GOLD_STARS_ACCEPTED:
            self.assertEqual((entry["version"], entry["skills"]), ("1.1.0", ["gold-stars"]))
        everything = sorted(mini.READ_OPERATIONS | mini.WRITE_OPERATIONS - {"mini-app.read"})
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            for entry in mini.GOLD_STARS_ACCEPTED:
                path.write_text(json.dumps({"version": 1, "apps": [{"id": "gold-stars", **entry}]}))
                for op in everything:
                    with self.subTest(ops=len(entry["operations"]), op=op):
                        self.assertEqual(mini.installed(home, "gold-stars", op), op in entry["operations"])
            app = {"id": "gold-stars", **mini.GOLD_STARS}
            restored = {"id": "gold-stars", **mini.GOLD_STARS_RESTORED}
            previous = {"id": "gold-stars", **mini.GOLD_STARS_PREVIOUS}
            refused = (
                [{**app, "operations": ["rolodex.person"] + eight}],  # not appended last
                [{**app, "operations": eight[:6] + ["rolodex.person"] + eight[6:]}],
                [{**previous, "operations": six + ["rolodex.person"]}],  # person without the restore
                [{**app, "operations": nine + ["rolodex.person"]}],
                [{**app, "operations": nine + ["rolodex.profile"]}],
                [{**app, "version": "1.2.0"}], [app, restored], [restored, previous], [app, previous],
            )
            for apps in refused:
                path.write_text(json.dumps({"version": 1, "apps": apps}))
                with self.subTest(apps=apps):
                    self.assertFalse(mini.installed(home, "gold-stars", "rolodex.person"))
                    self.assertFalse(mini.installed(home, "gold-stars", "rolodex.search"))

    def test_rolodex_person_is_a_read(self):
        self.assertIn("rolodex.person", mini.READ_OPERATIONS)
        self.assertNotIn("rolodex.person", mini.WRITE_OPERATIONS)
        self.assertFalse(mini.READ_OPERATIONS & mini.WRITE_OPERATIONS)

    def test_new03_app_operations_accepted_by_exact_shape_only(self):
        # NEW-03 (rc44): a non-Gold-Stars app carries exactly the public read, or the read plus its own
        # context namespace read and write (newest first). Anything else refuses that app alone (RA42 ov S1:
        # per app, as the installer's checkApp); the reviewed apps of the same file stay installed.
        read, ctx_read, ctx_write = "mini-app.read", "mini-app.context.read", "mini-app.context.write"
        self.assertEqual(mini.APP_OPERATIONS_ACCEPTED, ((read, ctx_read, ctx_write), (read,)))
        self.assertIn(ctx_read, mini.READ_OPERATIONS)
        self.assertNotIn(ctx_read, mini.WRITE_OPERATIONS)
        self.assertIn(ctx_write, mini.WRITE_OPERATIONS)
        self.assertNotIn(ctx_write, mini.READ_OPERATIONS)
        self.assertFalse(mini.READ_OPERATIONS & mini.WRITE_OPERATIONS)
        everything = sorted(mini.READ_OPERATIONS | mini.WRITE_OPERATIONS)
        gold = {"id": "gold-stars", **mini.GOLD_STARS}
        dizko = {"id": "dizko", "version": "1.0.0", "skills": ["dizko"]}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            for ops in mini.APP_OPERATIONS_ACCEPTED:
                path.write_text(json.dumps({"version": 1, "apps": [gold, {**dizko, "operations": list(ops)}]}))
                for op in everything:
                    with self.subTest(ops=ops, op=op):
                        self.assertEqual(mini.installed(home, "dizko", op), op in ops)
                        # Gold Stars keeps exactly its own operations beside either shape.
                        self.assertEqual(mini.installed(home, "gold-stars", op), op in mini.GOLD_STARS["operations"])
            # allowed() is per app: an entry without the context ops gets none, even beside one that has them.
            guide = {"id": "public-guide", "version": "1.0.0", "skills": ["public-guide"], "operations": [read, ctx_read, ctx_write]}
            path.write_text(json.dumps({"version": 1, "apps": [{**dizko, "operations": [read]}, guide]}))
            self.assertTrue(mini.installed(home, "dizko", read))
            self.assertFalse(mini.installed(home, "dizko", ctx_read))
            self.assertFalse(mini.installed(home, "dizko", ctx_write))
            self.assertTrue(mini.installed(home, "public-guide", ctx_write))
            self.assertFalse(mini.installed(home, "gold-stars", ctx_read))
            planted = (
                [read, ctx_read, ctx_write, "mini-app.context.delete"], [read, "mini-app.context.delete"],
                [read, ctx_read, "mini-app.context.delete"], [read, "mini-app.admin"], [read, ctx_read, ctx_write, "mini-app.admin"],
                [read, "gold-stars.send"], [read, ctx_read, ctx_write, "gold-stars.send"], ["gold-stars.send"],
                [read, "rolodex.meeting"], [read, ctx_read, ctx_write, "rolodex.person"],
                [ctx_read, read, ctx_write], [read, ctx_write, ctx_read], [ctx_write, ctx_read, read],  # reordered
                [read, read], [read, ctx_read, ctx_read, ctx_write], [read, ctx_read, ctx_write, ctx_write],  # duplicates
                [read, ctx_read], [read, ctx_write], [ctx_read, ctx_write], [ctx_read], [ctx_write], [],  # partial
                [read, "Mini-App.Context.Write"], [read, ctx_read + " ", ctx_write], read, None, {read: True},
            )
            for operations in planted:
                path.write_text(json.dumps({"version": 1, "apps": [gold, {**dizko, "operations": operations}]}))
                with self.subTest(operations=operations):
                    for op in everything:
                        self.assertFalse(mini.installed(home, "dizko", op))
                        # RA42 ov S1: dizko alone is refused; Gold Stars keeps exactly its own operations.
                        self.assertEqual(mini.installed(home, "gold-stars", op), op in mini.GOLD_STARS["operations"])

    def test_mosaic_entries_granted_like_dizko_and_skills_must_be_exactly_mosaic(self):
        # MOSAIC (app#486, rides v2.1.9): no plugin change. The generic branch grants Mosaic's two reviewed
        # lists (install/install_miniapps.ts) only with skills exactly ["mosaic"]; `[]`, a missing name or
        # another skill refuses Mosaic alone (RA42 ov S1: per app); Gold Stars stays installed.
        read, ctx_read, ctx_write = "mini-app.read", "mini-app.context.read", "mini-app.context.write"
        gold = {"id": "gold-stars", **mini.GOLD_STARS}
        mosaic = {"id": "mosaic", "version": "1.0.0", "skills": ["mosaic"]}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            path = home / "mini-apps.json"
            for ops in ((read, ctx_read, ctx_write), (read,)):
                path.write_text(json.dumps({"version": 1, "apps": [gold, {**mosaic, "operations": list(ops)}]}))
                for op in (read, ctx_read, ctx_write, "gold-stars.send", "rolodex.person"):
                    with self.subTest(ops=ops, op=op):
                        self.assertEqual(mini.installed(home, "mosaic", op), op in ops)
                self.assertTrue(mini.installed(home, "gold-stars", "rolodex.search"))
            for skills in ([], ["mosaic-box"], ["dizko"], ["mosaic", "mosaic"], "mosaic", None):
                path.write_text(json.dumps({"version": 1, "apps": [gold, {**mosaic, "skills": skills, "operations": [read, ctx_read, ctx_write]}]}))
                with self.subTest(skills=skills):
                    self.assertFalse(mini.installed(home, "mosaic", ctx_read))
                    self.assertTrue(mini.installed(home, "gold-stars", "rolodex.search"))
            # An install of another app never carries Mosaic's operations.
            path.write_text(json.dumps({"version": 1, "apps": [gold, {"id": "dizko", "version": "1.0.0", "skills": ["dizko"], "operations": [read, ctx_read, ctx_write]}]}))
            self.assertFalse(mini.installed(home, "mosaic", ctx_read))

    def test_new03_gold_stars_entries_unchanged_and_never_carry_context_ops(self):
        read, ctx_read, ctx_write = "mini-app.read", "mini-app.context.read", "mini-app.context.write"
        self.assertEqual(len(mini.GOLD_STARS_ACCEPTED), 3)
        for entry in mini.GOLD_STARS_ACCEPTED:
            self.assertFalse({read, ctx_read, ctx_write} & set(entry["operations"]))
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "mini-apps.json"
            for entry in mini.GOLD_STARS_ACCEPTED:
                app = {"id": "gold-stars", **entry}
                path.write_text(json.dumps({"version": 1, "apps": [app]}))
                self.assertTrue(mini.installed(home, "gold-stars", "rolodex.search"))
                for ops in ([ctx_read, ctx_write], [ctx_read], [ctx_write], [read, ctx_read, ctx_write]):
                    for apps in ([{**app, "operations": entry["operations"] + ops}], [{**app, "operations": ops + entry["operations"]}], [{**app, "operations": ops}]):
                        path.write_text(json.dumps({"version": 1, "apps": apps}))
                        with self.subTest(entry=len(entry["operations"]), apps=apps):
                            self.assertFalse(mini.installed(home, "gold-stars", "rolodex.search"))
                            self.assertFalse(mini.installed(home, "gold-stars", ctx_write))

    def test_disabled_missing_and_unverified_authority_refused(self):
        for configured, switch, codes in ((False, "on", ()), (True, "off", ()), (True, "on", ("hook-missing:village",))):
            ap = types.SimpleNamespace(configured=lambda: configured)
            gate = types.SimpleNamespace(switch=lambda: switch, current_codes=lambda: codes)
            with patch.object(mini.importlib, "import_module", side_effect=[ap, gate]):
                with self.assertRaises(ValueError):
                    mini.approval_modules()


if __name__ == "__main__":
    unittest.main()
