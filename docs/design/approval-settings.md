# Approval settings: per-class autonomy, store, routes, page

Status: draft spec, v1 (2026-10-05), task DATA-322 (wave 2 lane B4). Owner: Carter. Builds on the
onboarding review (DATA-259: `control-plane/src/approval-review.js`, `docs/APPROVAL-REVIEW.md`,
migration 0030) and app PR #3 in `Edge-City/agentvillage-app`. Marks: [V] verified against code
or a decision record, [NV] not yet verified, [DECISION NEEDED: who] open, with a recommendation.
Code facts were read on 2026-10-05 from the control plane's `main` (a7e0de0), this repo's `main`
(28940be), approval.md `main` (fb0cf98) and `agentvillage-data` `main` (edac49f).

## 1. Purpose

1. The resident chooses, per action class, what their agent does: on its own (`autonomous`), after
   asking them (`ask`), or not at all (`never`); on inferred intents also "act, then let me review"
   (`review_after`, core's `supervised-retro`). They choose on an onboarding page and later from the
   app's `/approvals` page.
2. The policy attested in their daemon's store is the rendered form of those choices. Nothing else
   about approval.md changes: the same template, the same root step, the same attestation paths
   (operator in `recorded` mode, the resident through the relay in `relay` mode), the same hash
   binding the review route already has [V `approval-review.js`].
3. This generalises the review's three switches (S1 to S3) to the full class table. Quiet hours (S4)
   stay a relay setting, never a policy row, and keep their column in `approval_reviews` [V].

## 2. The settings model

The table is closed: the control plane holds it as code (one frozen array, as `SWITCHES` is today
[V]); a class or value outside it is refused at every door. Values are the same four words for every
class; the page's labels differ per class (section 6).

| Class | Kind | Values offered (Oct 11) | Default | `review_after` |
|---|---|---|---|---|
| `message.send` | hook | autonomous, ask, never | autonomous | no |
| `network.call` | hook | autonomous, ask, never | autonomous | no |
| `read.web` | hook | autonomous, ask, never | autonomous | no |
| `browser.exec` | hook | autonomous, ask, never | autonomous | no |
| `cron.manage` | hook | autonomous, ask, never | autonomous | no |
| `process.write` | hook | autonomous, ask, never | autonomous | no |
| `skill.manage` | hook | autonomous, ask, never | autonomous | no |
| `agent.delegate` | hook | autonomous, ask, never | autonomous | no |
| `intent.publish.inferred.index` | propose | ask, review_after, autonomous, never | ask | yes |
| `intent.publish.stated.index` | propose | autonomous, ask, never | autonomous | no |
| `digest.share` | propose (reserved) | ask, autonomous, never | ask | no |
| `village.vote` | propose (reserved) | ask, autonomous, never | ask | no |
| `treasury.propose` | propose (reserved) | ask, never | ask | no |
| `policy.core` | human-only | shown, locked | human-only | no |
| `log.mutate` | human-only | shown, locked | human-only | no |
| `account.credential` | human-only | shown, locked | human-only | no |

1. **Defaults** are the template's rows exactly [V `templates/resident-approval-policy.md`], plus
   the one new row `treasury.propose` (section 9). A tenant nobody touched renders byte for byte
   what the template renders, as the review's defaults do today [V].
2. **Fixed rows, not on the page:** `intent.publish.*` (manual, `agent_may_request: true`: keeps a
   future `intent.publish.<x>` proposable without an edit), `files.delete.scratch` (autonomous) and
   `defaults.autonomy: autonomous` [V template]. The settings never write them.
3. **Reserved classes** (wave-2 rule "reserve now, build later"): `digest.share` and `village.vote`
   are in the template today [V]; `treasury.propose` joins it before Oct 11 (ODS spec §7 and §10;
   DATA-292), so week 2 needs no policy amendment. `village.vote`'s autonomous form is "answer for
   me", its never form "do not take part" (today's `answer` and `abstain` [V]).
4. **`treasury.propose` offers ask and never only.** Adding an allowed value later is not a policy
   amendment: a value is rendered only once someone picks it. So `autonomous` waits for the
   treasury design [DECISION NEEDED: Timour; recommendation: ask and never for week 2].
5. **`review_after` only on inferred intents** for Oct 11. Its review card and record are core lane
   A3 (APRV-480 to APRV-483) [NV until merged and in the pinned CLI]; until the pinned CLI has them
   the page hides the option and the PUT refuses it (`value_unavailable`).
6. **Inferred intents keep the morning-brief receipt.** Today's `publish_then_tell` and `publish`
   are one policy row with two receipts (DATA-222) [V]. Here they are `autonomous` plus a top-level
   `receipt` (`none` | `morning_brief`), written to `approval_reviews.receipt` in the same
   transaction so its future reader is unchanged. Nothing outside `approval-review.js` reads that
   column yet [V grep].

**Value to policy terms.** One function, no other forms:

| Value | Hook row | Propose row |
|---|---|---|
| autonomous | `{ autonomy: autonomous }` | `{ autonomy: autonomous, agent_may_request: true }` |
| ask | `{ autonomy: manual }` | `{ autonomy: manual, agent_may_request: true }` |
| never | `{ autonomy: human-only }` | `{ autonomy: human-only }` |
| review_after | (not offered) | `{ autonomy: supervised-retro, retro_rate: 1, agent_may_request: true }` |

7. `never` carries no `agent_may_request`: core refuses the flag on a human-only row at load [V
   SPEC §5.2], and the agent cannot even propose the class (the review's rule today [V]).
8. Hook rows never carry `agent_may_request`: the hook opens the request, not `propose` [V template
   rows]. `retro_rate` is legal only on supervised levels, in (0, 1] [V `policy.schema.json`].
9. `retro_rate: 1` reviews every inferred intent after it is published, which is what makes the
   review count as an individual approval [DECISION NEEDED: Carter; recommendation: 1 for October,
   a sampled rate only if the review load is too high]. If core's sampler needs
   `audit.sampling_secret_env` even at rate 1, the template gains that line now [NV; A3 to answer].
10. The JSON a client sends and receives:
    `{"classes": {"message.send": "autonomous", ...}, "receipt": "none", "skills": {}}`.
    `skills` is reserved and must be `{}` until phase 2 (section 9).

## 3. The cap

1. A hook class on `ask` holds the tool call while the resident is asked, up to the harness cap:
   240 s, the 300 s cap minus core's 60 s margin [V `docs/hermes-hook.md`, approval.md]. From 0.4.1
   the wait yields, so a signal mid-wait withdraws the request and blocks the call [V APRV-475 and
   APRV-478 merged on approval.md `main`; NV until 0.4.1 is cut and pinned].
2. At the cap the call is blocked and the request withdrawn. The agent tells the resident what it
   was about to do and does it only if they ask again and approve; asking again is a new tool call
   and a new request [V `skills/approval/SKILL.md`, "When a call is waiting"]. A tap after the cap
   finds a withdrawn request [NV: the card's exact wording].
3. Quiet hours do not hold a hook request: a prompt that would expire before 09:00 goes out at once
   [V template comment], and 240 s always does. A resident who sets a hook class to `ask` can be
   pinged at night; the page says so.
4. The page states the cap in one sentence (section 6). The two classes a resident will feel are
   `message.send` (the `send_message` tool) and `network.call` (curl and the like from the
   terminal). Brief-lite job deliveries do not go through `send_message` [NV].
5. APRV-484 (DATA-213, carry and replay past the cap) is the week-one fast-follow. It changes what a
   late tap does, not the model: the value stays `ask`, and nothing here is re-rendered.
6. A hook class on `ask` or `never` does nothing while the tenant's hook is not wired:
   `APPROVALD_ENFORCE` unset or off writes no `AV_APPROVAL_URL` into Hermes's env [V
   `approvald.js hermesEnvLines`]. The GET says `hook_gate: on | off`; with `off` the page shows
   hook rows with "takes effect when your approval gate is switched on" [DECISION NEEDED: Carter;
   recommendation: show with that note, never hide].
7. `ask` on any class needs a paired approver: with no Telegram pairing there is no chat, and every
   hook `ask` would block after 240 s with nobody asked [V `renderUnpairedPolicy`]. The PUT refuses
   `ask` on a hook class while unpaired (`approver_unpaired`); propose classes keep their default
   `ask`, as today [DECISION NEEDED: Carter; recommendation: as written]. This is lane B3's rule:
   the only way past the approvals-bot step without pairing is the "everything autonomous" preset.

## 4. Storage and routes (control plane)

**Recommendation: a new table `approval_settings`, not new columns on `approval_reviews`.**
`approval_reviews` is one row per tenant with a CHECK column per switch [V 0030]: every new class
would be an `ALTER TABLE` on a live table, and it keeps no history, which research needs (section
7). A new table touches nothing the running release reads, as 0030 did [V]. Migration `0032`, the
next free after #77's `0031` [NV; claim it in CLAIMS before building].

```sql
CREATE TABLE approval_settings (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version >= 1),
  settings      JSONB NOT NULL,              -- section 2 item 10, validated in code against the closed set
  preset        TEXT NOT NULL CHECK (preset IN ('recommended','all_autonomous','custom')),
  source        TEXT NOT NULL CHECK (source IN ('settings','review','migration')),
  policy_sha256 TEXT NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),  -- the bytes rendered at write
  mode          TEXT NOT NULL CHECK (mode IN ('recorded','relay')),
  apply_state   TEXT NOT NULL CHECK (apply_state IN ('pending','applied','failed','superseded')),
  attested_by   TEXT NULL CHECK (attested_by IN ('operator','resident')),
  apply_attempts INTEGER NOT NULL DEFAULT 0,
  applied_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);
```

1. Current settings = the highest version; no row = the defaults. The migration writes version 1
   (`source: migration`) for each tenant with an `approval_reviews` row, mapped as in section 2
   item 6 (`draft`=ask, `answer`=autonomous, `abstain`=never, `share`=autonomous).
2. The root step renders from the latest version whatever its state (a superseded one is never
   the latest; it replaces `switchesOfRow` in `renderStoredPolicy`). A failed read renders nothing: fail closed, as today [V].
   An unknown stored class or value refuses the render, never a guess [V the review's invariant].
3. `GET /tenants/:id/approval/settings` (API key; live, co-located tenants; consent-independent: the
   review route's guards [V]). Optional preview `?set=<class>:<value>,...&receipt=<r>`, each class at
   most once, validated against the closed set; `X-EdgeOS-Id` as on the review GET. Answers:
   `version`, `settings`, `receipt`, `quiet_hours`, `table` (section 2, with labels, allowed values,
   `locked`, `offered`), `presets`, `plain_words`, `statements`, `cap_sentence`, `rendered_policy`,
   `policy_sha256` (over exactly that string, as the review [V]), `in_force_sha256`, `unchanged`,
   `mode`, `attested_by`, `attested_at`, `apply_state`, `hook_gate`, `approver_paired`,
   `edgeos_mapped`.
4. `PUT /tenants/:id/approval/settings` with `{base_version, seen_sha256, settings, preset,
   quiet_hours, edgeos_id}` (the last two stored in `approval_reviews` as the review does [V]).
   The full table: every editable class present (`field_missing`), no
   unknown (`class_unknown`) or locked class (`class_locked`), each value allowed (`value_invalid`)
   and available (`value_unavailable`: `review_after` until the state read reports a CLI with A3
   [NV how it is probed]). Then, in order:
   1. one tenant at a time: the review route's in-flight set, shared by both routes
      (`409 settings_in_progress`) [V the set is in-process, one replica];
   2. `base_version` must be the current version (0 for none): the new row's version is
      `base_version + 1`, so of two racing inserts the primary key fails one, which also covers two
      control-plane processes during a deploy: `409 settings_version_conflict`, current version;
   3. render; `seen_sha256` must equal the hash (`409 stale_policy`, nothing written) [V binding];
   4. **recorded mode**: insert the version `pending`, run the root step
      (`tenants.runApprovaldStep`: render, write, attest as `human:<APPROVAL_OPERATOR_ID>`, restart
      the daemon on a changed policy [V approvald.js 3b]), read the store back. In force: `applied`,
      `200`. Not in force (the step failed): stays `pending`, `202 {apply_state: "pending"}`; the
      page shows "applying". The review's refusals stand: `resident_attested`, `operator_mismatch`
      [V]. A box that cannot be read before the render: with `APPROVAL_REVIEW_RELAY` off the mode
      is known to be `recorded`, so the version is inserted `pending` (`202`; a store a resident
      attested meanwhile is held by the step and ends `failed`); with it on, `503`;
   5. **relay mode**: the review's relay exec unchanged (listener and key checks, write, `propose`,
      `attest` with sender `{channel: edgeos, id}`, EXIT-trap restore) [V]; then `applied` with
      `attested_by: resident`. Daemon or relay down: `503 daemon_unreachable`, nothing inserted. A
      resident-attested store is never rewritten by the root step [V], so a pending relay version
      could only ever be applied by the resident again; none is kept.
5. **Idempotency.** A PUT whose settings equal the current version's answers `200 unchanged: true`
   and inserts nothing, even with a stale `base_version` (a retried PUT after a lost answer). An
   unchanged PUT in relay mode still proposes (core answers `reaffirm`), as the review does [V].
6. **Pending applies are retried** by the approvald liveness job's tick: a tenant whose latest
   version is `pending` gets the root step under the rewire lease, at most once per 10 minutes, then
   `failed` after 6 attempts (`approvald_settings_unapplied` while `APPROVALD_ENFORCE=1`). Any other
   full root step (update, recreate, pairing) applies it too [DECISION NEEDED: claude-main;
   recommendation: as written]. A newer version marks older pending ones `superseded`.
7. **A save voids pending proposals.** Any new attestation voids every request pending under the
   old hash (`policy-drift`) [V SPEC §5.2]: an inferred intent waiting for a tap must be filed again.
   The page says so when proposals are pending; whether the overlay re-files them by itself [NV].
8. **The review route becomes an adapter.** `POST /approval/review` with `accept: true` is a PUT
   that changes only the three S1 to S3 classes (`source: review`); a decline writes no version and
   emits the review event as today. Its GET answers `409 use_settings_route` once a tenant holds a
   value the three switches cannot express (`never` on inferred intents, `review_after`, any hook
   class not at its default). Retire it once the app has switched (week 1).
9. **The event: a new type, `tenant.approval_settings@1`** (actor `participant`; `operator` for
   `source: migration`). `tenant.approval_review@1` is closed at every level with the three
   switches only [V `src/schemas/index.ts`], so widening it is a `@2` anyway, and it records an act
   (accept or decline) where this records a version. Payload, closed: `settings_version`,
   `settings` (closed class and value sets), `receipt`, `preset`, `source`, `policy_sha256`,
   `mode`, `attested_by`, `apply_state`. Emitted in the transaction that writes each state change
   (`pending`, `applied`, `failed`), and by the root step when it puts a new digest in force for an
   unchanged version (a pairing, a re-key, a template change), so every digest maps to a version.
   Behind `APPROVAL_SETTINGS_EVENTS`, on only once ingest registers the type [V the review's order].

## 5. Rendering

1. One pure function, `renderSettings({settings, telegramUserId, tenantId, edgeosId,
   edgeosSender, senderKey})`, replacing `renderReview`'s switch loop: DATA-250's bytes (paired or
   unpaired), then each class row of the closed table rewritten from section 2's mapping, then the
   EdgeOS line as today [V]. Same inputs, same bytes.
2. Today's `setRow` replaces only a manual propose row [V `approval-review.js`]; the new one
   replaces whatever `{ ... }` body the class line has, keeping the alignment and trailing comment,
   and refuses a template where a class row is missing or appears twice (`policy_template_invalid`).
3. Tests: one golden file per class per allowed value (each from the defaults; 39 files), plus
   all-defaults (byte-identical to the template render), the two presets, all-ask and all-never.
   Rows are independent, so the per-row goldens plus a test that a render changes only the rows
   named cover the ~1.4 million combinations. Every golden passes core's `policy check` under the
   pinned CLI (the real-core runs the review tests already make [V]).
4. **The digest.** `policy_sha256` is the SHA-256 of the rendered bytes. It changes with any row
   and with the sender lines; both sender lines are keyed, so the digest discloses no account [V
   APPROVAL-REVIEW.md, "The review event's policy_sha256"]. A store still holding a raw line is the
   exception the fleet check lists [V].
5. **The follower.** Decisions already carry the digest the follower ran under as
   `policy_version` (DATA-212; `stg_action_attempted.policy_version`) [V `_objects.yml`]. The data
   side maps `(tenant, policy_version)` to a settings version through the event's `policy_sha256`
   (section 4 item 9). No follower change, provided it reads the digest per decision rather than
   once at start [NV; DATA-216 owner to confirm].

## 6. The page

1. **Placement.** Onboarding: after the approvals-bot pairing (lane B3), before "Your agent is
   ready", in place of PR #3's review step [V PR #3]. Later: `/approvals`, the same component, from
   the sidebar and the dashboard row [V PR #3]. "Decide later" keeps the defaults.
2. **Layout.** A summary on top in three lists by current value: "Your agent does these on its
   own", "It asks you first", "It never does these". Below, rows grouped by kind so they do not
   move on a change: "Things your agent does with its tools" (hook), "Things your agent proposes for
   you" (propose), "Never your agent's" (human-only, locked, with a lock icon and no control).
3. **Presets.** "Recommended" (the defaults) and "Everything on its own" (every editable class
   `autonomous`; `treasury.propose` is `never`, since it offers no autonomous value). The second is
   B3's way past pairing. Choosing a preset fills the rows; any edit makes it `custom`.
4. **Cap sentence** (above the hook group, verbatim): "If you choose Ask me for something your
   agent does with its tools, it waits up to 4 minutes for your tap, even at night; after that it
   stops, tells you what it was about to do, and does it only if you ask again."
5. **Save** renders a preview (GET with `?set=`), checks the hash as PR #3 does, then PUTs.
   `202` shows "Applying to your agent..." and polls the GET until `apply_state` is `applied`;
   `failed` shows "Not applied yet; we are on it" (an operator case).
6. **Copy, the app owner to edit.** The control plane owns it, as `plain_words` [V PR #3 rule].

| Class | Label | One line |
|---|---|---|
| `message.send` | Send messages for you | Sends a message with its messaging tool. Its replies to you are not this. |
| `network.call` | Reach other services | Calls a web address or service from its terminal. |
| `read.web` | Read web pages | Fetches a web page to read it. |
| `browser.exec` | Use a browser | Opens pages, clicks and fills in forms in a browser. |
| `cron.manage` | Schedule jobs | Creates or changes a scheduled job. What the job runs later is not asked about. |
| `process.write` | Control running programs | Sends input to, or stops, a program it started. |
| `skill.manage` | Change its own skills | Adds, edits or removes one of its skills. |
| `agent.delegate` | Hand work to a helper | Starts a helper agent. What the helper does may not be asked about. |
| `intent.publish.inferred.index` | Intents it infers about you | Offers on Index something it worked out you want. |
| `intent.publish.stated.index` | Intents you state | Offers on Index something you asked it to. |
| `digest.share` | Sharing a digest about you | Shares a short summary about you with the village. |
| `village.vote` | The weekly village question | Answers the village's weekly question for you. |
| `treasury.propose` | Treasury proposals | Proposes that the village treasury fund something for you. |
| `policy.core` | Its own rules | Changing these settings or its approval gate. |
| `log.mutate` | Its own record | Editing or deleting the log of what it did. |
| `account.credential` | Your passwords and keys | Reading or changing your credentials. |

7. Option words: "On its own" / "Ask me first" / "Never" / "Publish, then let me review each one"
   (`review_after`); on inferred intents "On its own" splits into "Publish, then tell me in my
   morning brief" and "Publish" (the receipt). `village.vote` keeps "Draft it for my approval",
   "Answer for me", "Do not take part" [V `SWITCHES`].

## 7. Research

1. **Added:** each tenant's settings version history (`tenant.approval_settings@1`: version,
   values, preset, source, digest, mode, attester, apply state, times). A mart
   `approval_settings_history` (one row per tenant-version with `valid_from` and `valid_to` by
   `applied`) beside DATA-284's `approval_settings`, which keeps reading the review event [V mart].
2. **Already there:** the observed condition per action follows from decisions: `policy_version`
   joins to a version, the version to the class's value (section 5 item 5).
3. **Not stored:** no text and no secrets. Values are enums; the digest is over keyed sender lines;
   the EdgeOS id stays in the control plane's own row [V 0030]; `rendered_policy` goes only to the
   resident's own screen. Whether this event inherits the review event's staging-only restriction
   [DECISION NEEDED: Carter; recommendation: lift it for both, the digest no longer names an
   account].

## 8. Acceptance on the dogfood tenants

1. GET on an untouched tenant: no version, the defaults, `unchanged: true`, human-only rows locked,
   `treasury.propose` present at `ask`.
2. PUT "Recommended": `200 unchanged: true`, no version written, no daemon restart.
3. PUT `message.send: ask`: version 2 `applied`; `send_message` waits; the resident taps yes within
   4 minutes; the call runs; the decision's `policy_version` is version 2's digest.
4. The same, no tap: blocked at 240 s; the agent says what it was about to do; a tap after finds a
   withdrawn request; "do it" from the resident opens a new request.
5. `network.call: never`: a terminal curl is refused as human-only; the agent explains and does not
   route around it.
6. `review_after` on inferred intents (once A3 is pinned): published at once, a review card arrives,
   the review is recorded with its verdict.
7. Two PUTs on the same `base_version`: one `200`, one `409 settings_version_conflict`; a replay of
   the winner: `200 unchanged: true`.
8. Daemon down, recorded mode (Carter stops approvald by hand): PUT answers `202 pending`, the page
   shows "applying"; the daemon is restarted; within one liveness tick the version is `applied`
   and both events landed.
9. Relay mode (`APPROVAL_REVIEW_RELAY=1` on dogfood only): PUT, the log shows `policy.updated` with
   a keyed edgeos sender, `attested_by: resident`; a later root step leaves it held. Relay down:
   `503 daemon_unreachable`, no version written.
10. Unpaired tenant: `ask` on a hook class is `409 approver_unpaired`; "Everything on its own" goes
    through.
11. `APPROVALD_ENFORCE` off: `hook_gate: off`, the note shows, the PUT renders and attests, nothing
    blocks.
12. The review route: accepting S2 `answer` writes a settings version with `source: review`; after
    `network.call: never` its GET answers `409 use_settings_route`.
13. Research: both versions in ingest, the history mart has two rows, decisions join to them.

## 9. Sequence

**For Oct 11:** the template's `treasury.propose` row (manual, `agent_may_request: true`), and the
`audit` line if A3 needs it; this lands as an operator amendment (`write=amended`) on each
operator-attested store at its next root step [V approvald.js case 3], so it must ship before any
relay-mode review makes a store resident-attested. Then migration 0032, `renderSettings`, the
routes, the review adapter, the retry tick, the event (registered data-side first), the page.

**After:** APRV-484 carry and replay (week 1, a batched roll; no settings change); `treasury.propose`
autonomous (with DATA-292); `review_after` on more classes; a `skills` section in the same JSON for
skill toggles, reserved as `{}` and hidden until phase 2 (it needs the installer's manifest and a
roll); a `resource.request` class only if the ODS spec's Q12 says yes.

## 10. Build tasks and open questions

| # | Task | Owner | Size |
|---|---|---|---|
| 1 | Template row `treasury.propose` (control plane template and this repo's mirror `skills/approval/templates/`), fleet amendment checked by the fleet check | claude-main (cp), Claude-2 (mirror) | S |
| 2 | Migration 0032 `approval_settings` + backfill; `renderSettings`; GET/PUT; review adapter; retry tick; event builder; goldens and core load checks; runbook `docs/APPROVAL-SETTINGS.md`; refuter on the complete diff | claude-main | M |
| 3 | App: generalise PR #3's component to the table, presets, summary, cap sentence, applying state, `hook_gate` and `approver_paired` states; draft PR for the app owner | claude-edge | M |
| 4 | Data: register `tenant.approval_settings@1` (closed) for `control_plane`; staging and `approval_settings_history`; digest-to-version join; confirm the follower's per-decision digest | claude-main | S |
| 5 | Overlay: SKILL.md one line for `review_after` ("published, then shown to them to review") | Claude-2 | S |

Open questions (each with a recommendation; decider named):

1. Four options on inferred intents (`review_after` beside the two autonomous receipts)? Recommend
   yes; fold `publish_then_tell` into `review_after` later if residents confuse them. Carter.
2. `treasury.propose`: ask and never only until the design lands. Recommend yes. Timour.
3. Refuse hook `ask` while unpaired (section 3 item 7). Recommend yes. Carter.
4. `retro_rate: 1` for October. Recommend yes. Carter.
5. Hook rows while the gate is off: shown with a note. Recommend yes. Carter.
6. Retry of pending applies on the liveness tick (section 4 item 6). Recommend yes. claude-main.
7. "Recommended" equal to the defaults, or `cron.manage` and `skill.manage` on `ask` (rare and
   high-consequence)? Recommend the defaults for Oct 11: nothing holds a tool call until
   enforcement has run a week on the fleet. Carter.
8. Staging-only restriction on the settings and review events. Recommend lifting it. Carter.
9. Whether the overlay re-files proposals voided by a save (section 4 item 7). Claude-2 to answer.
