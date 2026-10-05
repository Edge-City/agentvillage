# The village treasury experiment: design

Status: design draft v1 (2026-10-05), task DATA-292. Owner: Carter; rules and research questions
need Timour's sign-off (DATA-292 AC #1). Base: the ODS spec draft (`operational-datastore-spec.md`,
DATA-291, PR #191, under review: "ODS spec §n"; §5.3 lists what this design asks of it) and
`docs/design/operational-datastore.md` v3 in `agentvillage-data` ("base §n"). Marks: [V] verified
against code or a decision record, [NV] not verified, [DECISION NEEDED: who] open, with a
recommendation. Code read 2026-10-05 on `origin/main` of `agentvillage-data`, the control plane and
this repo. Nothing here is built or live until §9.3's acceptance passes on the team tenants.

Principle (Carter): **agents never vote or spend; humans do, through agents.** An agent drafts and
its resident taps; Odin proposes and its principal taps; Edge City's operations team pays.

## 1. Purpose and the research questions it serves

A daily budget residents' agents propose to spend and residents vote on; Odin turns the result into
allocation proposals a human ratifies. It is the research framing's "bounded representation" module
("informing the allocation of a shared fund") and the first governed use of a shared resource.

| Research question (`research/overview.md`, data repo) | What the treasury contributes |
|---|---|
| RQ1 Collective behaviour (capture, collusion, exclusion) | concentration, capture and bloc measures over a real shared pool (§7.3 M5 to M7) |
| RQ3 Delegation and ratification | tapped versus policy (`answer`) votes, decline rate of agent drafts, principal overrides (M10 to M12) |
| RQ4 Human outcomes | whether a funded proposal becomes a verified, useful outcome (M8, M9) |
| RQ5 Comparative performance | outcomes by observed condition, never assigned (§7.2) |
| RQ2 Negotiated coordination | not served: no agent-to-agent negotiation is in this design |

Hypotheses (`research/overview.md`): **coordination**, agents surface and carry out village actions
that would otherwise not happen; **safety**, a shared pool's safety depends on the rules around it
(caps, quorum, ratification, kill switch), not on the model. §7.1 makes them testable.

**A useful outcome for a treasury proposal**: the funded thing happened as proposed (operator
verified against the proposal's `verify_by` line and the payment receipt) and the proposer reports
it useful. The treasury's primary measure is the village metric's analogue: verified useful
outcomes per eligible proposal, where eligible means granted by its resident and listed on a ballot.

**Measured**: proposals, taps, votes, tallies, allocations, executions, outcomes, their timing.
**Not measured**: whether a funded thing was worth its cost or would have happened anyway, a vote's
rationale (it never travels), external agents, individual votes without research consent.

## 2. The rules

### 2.1 Budget and money

- **Amount**: 250 USD per budget day, 14 budget days (Oct 18 to Oct 31), at most 3,500 USD
  [DECISION NEEDED: Timour, that the line exists and who funds it].
- **Who holds it**: Edge City's operating account; a budget line, not a wallet. No agent, service or
  resident holds money, keys or credit for it. No crypto.
- **Currency**: USD in records (`amount_cents`, whole dollars); paid in INR at operations' rate on
  the day, the INR figure kept on the operations ledger [NV].
- **No carry-over**: an unallocated remainder lapses to Edge City, so days stay comparable and one
  day's exposure is capped at 250 USD.
- **Not inference.** OpenRouter top-ups above the 25 USD baseline are base §6's own pool; no
  proposal funds inference credit [DECISION NEEDED: Timour; recommendation: keep the pools apart,
  since mixing them invites residents to vote themselves compute].

### 2.2 Who may propose

- **Residents, through their hosted agent** (draft, then tap, class `treasury.propose`, §3), with
  village consent in force (ODS spec §2.3) and a resolved `edgeos_ref` (ODS spec §6).
- **External agents**: tier 1 reads only. Tier 2 (the human submits in the Edge City app) and tier 3
  (DATA-290: the agent proposes, the human confirms in the app) need a control-plane route and an
  app form that do not exist [V]; neither is in week 2 (§7.5). Numbering follows DATA-292's source
  (1 read, 2 human submits, 3 confirm in app); DATA-290's title calls its route "tier 2".
- **Not**: Odin, operators, MoralMod, team tenants (they run the experiment and are its fixtures)
  [DECISION NEEDED: Timour on team tenants; recommendation: no proposals, no counted votes].

### 2.3 Proposal shape

What the resident is shown and taps is exactly what is filed (the `_share_vote.py` rule: one
canonical string, RFC 8785, hashed) [V pattern]. Fields:

| Field | Rule |
|---|---|
| `proposal_id` | lower-case UUID the plugin mints |
| `title` | ≤ 80 characters, the digest text rule; becomes the ballot label with the amount |
| `text` (purpose) | ≤ 500 characters, the digest text rule; what, where, when, for whom |
| `amount_cents` | whole dollars, 10 to 100 USD (§2.4) |
| `budget_day` | the ballot date; the plugin picks the first day whose freeze (11:00 IST) is at least 2 hours away |
| `beneficiary_kind` | `organiser` (the proposer, reimbursed against receipts), `vendor` (Edge City pays a named vendor), `village` (Edge City buys and holds) |
| `verify_by` | ≤ 200 characters: what will show it happened (photos in the group, an EdgeOS event's RSVPs, a receipt) |
| `origin` | `stated` (the resident asked for it in their own words) or `inferred` (the agent suggested it); shown on the card |

No other person is named as beneficiary; no payment details enter a proposal, an event or the
ODS (operations collects them at payment). No `expires_at`: a proposal ends at its ballot's close
(§2.8). No links, no attachments: evidence is the `verify_by` line.

### 2.4 Eligibility and caps

- One live (`open`) proposal per resident.
- One funded proposal per resident per rolling 7 days; otherwise `not_listed` (`recently_funded`).
- Amount 10 to 100 USD, so a day funds at least two proposals when votes allow.
- At most 10 proposals per ballot (the ODS spec's 12-option cap less `none` and `abstain`), listed
  in grant order; the rest end `not_listed`, reason `ballot_full`, and may be refiled.
- After a decline, the agent may not draft another treasury proposal for that resident the same
  day; an agent drafts at most one `inferred` proposal per resident per day.
- [DECISION NEEDED: Timour on every number in this section.]

### 2.5 The daily cycle (Asia/Kolkata)

| Time (IST) | Step | Who |
|---|---|---|
| until D 11:00 | proposals for day D are drafted and tapped; the request's TTL ends at D 11:00 | resident, through the agent |
| D 11:00 | freeze: granted proposals for D, in grant order, up to 10 | the ballot job |
| D 12:00 | ballot opens: `village.question_opened@1`, kind `treasury_ballot` | the ballot job (`operator`; `odin` once its seat exists) |
| D 12:05 | each hosted agent drafts its resident's vote; the prompt arrives | overlay scheduled job |
| D 21:00 | ballot closes; vote requests' TTL ends | |
| by D 21:15 | tally (§2.7), `tally.closed@1`, result line | the ballot job |
| by D 21:30 | one `resource.allocate` request per funded proposal | Odin (operator fallback, §4.5) |
| D+1 18:00 | the principal's TTL ends; unratified means not funded | Timour |
| D + 10 days | execution deadline, and no later than Nov 3 [NV] | Edge City operations |

The window sits outside the approval relay's quiet hours (23:00 to 08:00 IST [V, the policy
template]), so no prompt waits overnight. Times [DECISION NEEDED: Timour].

### 2.6 Who may vote, and how

- **Eligible**: residents with a hosted agent, village consent, a resolved `edgeos_ref`, not a team
  tenant, S2 not `abstain`; frozen as `eligible_n` at open. Attendees without a hosted agent cannot
  vote in week 2; a tier-2 or tier-3 app vote would let them [DECISION NEEDED: Timour].
- **One EdgeOS identity, one vote**: `ods.votes` is keyed by question and tenant [V ODS spec §6]
  and `edgeos_ref` is unique; a vote from a tenant with no `edgeos_ref` is not counted.
- **How**: single choice. The agent drafts one answer, the resident taps it in the approval bot.
  Options: each listed proposal's `proposal_id`, `none` (reject: fund nothing today), `abstain`.
  `vote.cast@1` carries one option key [V]; one tap a day bounds the attention cost [DECISION
  NEEDED: Timour; the alternative, a yes/no question per proposal, costs up to ten taps a day].
- **Policy votes**: with S2 at `answer` the vote is cast without a tap (`authorization: policy`
  [V]); recorded and published apart, **not counted** [DECISION NEEDED: Timour; recommendation: not
  counted, per the principle; they still give the bounded-agent-led observation and M10].
- **Constraint**: approval.md binds `village.vote:<question_id>:<tenant>` to its first bytes, so a
  declined draft blocks every other answer on that ballot [V DATA-99 open item (c)]. Until that is
  fixed (Q-T21), the 12:05 job has the agent ask in chat which option first and draft only that one.

### 2.7 Tally, quorum and ties: rule `treasury_plurality_v1`

1. Counted votes: `authorization = grant`, from an eligible voter, one per EdgeOS identity.
2. Quorum: counted turnout (`abstain` included) of at least max(10, 15% of `eligible_n`)
   [NV numbers]. Below quorum nothing is funded.
3. If `none` has at least as many votes as the leading proposal, nothing is funded.
4. Order proposals by counted votes, descending; ties by smaller amount, then earlier grant, then
   `proposal_id`. Deterministic: no lottery, no discretion.
5. Walk the order: fund a proposal with at least 3 votes, more than `none`, whose amount fits what
   remains; otherwise skip it and continue (a smaller, lower-ranked proposal can still fit).
6. The remainder lapses (§2.1).

The rule is one pure function in `agentvillage-data`, versioned by its name in `tally_rule`. The
ballot job and Odin call the same function; neither chooses winners.

### 2.8 Unfunded, partial, refunds and receipts

- **Unfunded** (`not_funded` at close) or **not listed**: the proposal ends; the resident may refile
  it for a later day. No rollover. **No partial funding**: full or nothing, so the outcome is judged
  against the amount the proposer named.
- **Ratification declined or lapsed**: `not_funded`; the money lapses; no cascade down the ranking.
- **Payment** by Edge City operations: reimbursement against receipts (`organiser`) or direct
  payment (`vendor`, `village`); no cash advance. Refunds are rare by construction; a vendor refund
  returns to Edge City, not the treasury, noted on the operations ledger.
- **Receipts** stay with operations, off-system; `resource.executed@1` carries an opaque ledger
  reference. Unexecuted by the deadline: allocation `expired`.

## 3. Classes and autonomy

| Class | Seat | Default | Other options | Condition when used |
|---|---|---|---|---|
| `treasury.propose` | resident | manual: the agent drafts, the resident taps | none [DECISION NEEDED: Carter, fixed row versus a switch] | `agent_proposed_human_ratified` |
| `village.vote` | resident | `draft` (manual) [V S2] | `answer` (autonomous), `abstain` (human-only) [V] | grant: `agent_proposed_human_ratified`; policy: `bounded_agent_led` |
| `resource.allocate` | Odin | manual: the principal taps each request | no pre-authorisation in October [NV whether a policy version may pre-authorise under a ceiling; ODS spec Q3] | `agent_proposed_human_ratified` |

**Draft rows, resident template** (`control-plane/templates/resident-approval-policy.md`, the
DATA-250 bytes [V current rows]):

```yaml
  village.vote:                  { autonomy: manual, agent_may_request: true }   # the weekly question and the daily treasury ballot, DATA-99, DATA-292
  treasury.propose:              { autonomy: manual, agent_may_request: true }   # DATA-292, from Oct 18
```

The header's list of tap-gated classes gains "treasury.propose: a treasury proposal your agent
drafted, before it is filed". S2 still rewrites `village.vote`'s row [V `renderReview`].

**Draft rows, Odin's seat** (own policy on the DATA-255 Railway service; principal Timour [V B5b]):

```yaml
defaults: { autonomy: autonomous, channel: telegram, approval_ttl: 24h, on_expiry: reject, token_delivery: sealed }
approvers:
  principal: { channels: [telegram], senders: { telegram: "<principal's paired id>" } }
classes:
  resource.allocate:  { autonomy: manual, agent_may_request: true }   # treasury and registry allocations, DATA-292
  resource.topup:     { autonomy: manual, agent_may_request: true }   # the inference pool, base §6; not the treasury
  policy.core:        { autonomy: human-only }
  log.mutate:         { autonomy: human-only }
  account.credential: { autonomy: human-only }
```

[NV] whether the approver role name is free-form, whether a request may carry its own TTL (DATA-99
AC #3 assumes it), and whether policy grammar can bound an amount (nothing in today's template does).

**What the settings page shows** (the DATA-259 review, `SWITCHES` in `approval-review.js` [V]):

- `treasury.propose`: a fixed statement, not a switch: "Treasury proposals. From Oct 18 the village
  has a daily budget. Your agent may draft a proposal for you; nothing is filed until you approve it
  on Telegram. Residents see your name on it; the public does not." A switch needs an
  `approval_reviews` column, `REVIEW_SWITCH_VALUES`, the app form and `tenant.approval_review@2`
  (`switches` is closed at three keys [V]), all before Oct 11.
- `village.vote` (S2): copy names the weekly question and the daily ballot; `answer` adds "Answers
  your agent gives without asking are recorded apart and do not decide treasury funding"; `abstain`
  adds "This includes the daily treasury ballot". Copy is not hashed [V], but changing its meaning
  after residents chose is consent-shaped: before Oct 11.
- `resource.allocate`: not on a resident's page; the app's treasury page says Timour ratifies.

## 4. Odin's allocation gate

### 4.1 Inputs (through `ods_reader_coordination`, ODS spec §4.3)

- The tally (`ods.tallies`, final) and the funded set `treasury_plurality_v1` computes from it. Odin
  never reads individual votes [V ODS spec §8].
- The budget line: the day's `treasury_day` resource row and its remaining amount.
- Each funded proposal: title, text, amount, `beneficiary_kind`, `verify_by`, `origin`, proposer ref.
- Flags: near-duplicate titles across proposers, bloc signals from turnout timing (never votes).
- A MoralMod `recommendation.computed@1` [V type] when one exists (DATA-98 gate), attached by
  `recommendation_event_id` as evidence only; it never changes the funded set (base §7).

### 4.2 The request Odin files

One approval.md request per funded proposal, class `resource.allocate`, key
`resource.allocate:<proposal_id>`, payload exactly `{allocation_id, resource_id, proposal_id,
amount_cents, budget_day, tally_question_id}`; the summary carries the tally line, title, purpose,
flags and recommendation id. Odin may recommend a decline with a reason; it cannot add a proposal,
change an amount or reorder the tally. It emits `resource.requested@1` when it files.

### 4.3 Who ratifies

The principal, Timour (DATA-255, base §7), one tap per request, TTL to D+1 18:00 IST; a decline or
lapse ends the proposal `not_funded`. A deputy approver for days he is unreachable [DECISION
NEEDED: Timour; recommendation: none in week 2; a lapsed day is a finding, not a failure].

### 4.4 Execution

- **What exists**: the OpenRouter top-up route `POST /tenants/:id/openrouter/topup` [V], a
  non-atomic read-modify-write [V `topupTenantOpenrouter`]; the atomic fix, the scoped service token
  and `key.topped_up@2` are not built (ODS spec task 15). The treasury does not use it (§2.1).
- **What does not exist**: any fiat or crypto payout route [V: none in the control plane].
- **So "allocation" for a non-inference prize** is a ratified entitlement: the grant makes an
  `ods.allocations` row `allocated` (Odin emits `resource.allocated@1` with the approval link keys).
  When operations is ready to pay, Odin records the execution with approval.md `start` and the
  sealed token (DATA-213) [NV the hand-off]; operations pays (reimbursement or vendor) and records
  `resource.executed@1` (`operator`, §5.3 R3) with the `execution_token_id` and a ledger reference.
  Operations pays only against an `allocated` row whose decision the follower resolved.

### 4.5 Fallback before Odin's seat

DATA-255 is a post-launch build. Until its seat passes acceptance, the ballot job (`operator`
token) emits ballots and tallies, Timour ratifies the funded set in writing to Carter, and an
operator script emits `resource.allocated@1`; these read `human_led` [DECISION NEEDED: Carter].

### 4.6 Audit trail per funded proposal

`treasury.proposed` → follower `decision.ratified` (resident seat) → `village.question_opened` →
`vote.cast` → `tally.closed` → `resource.requested` → follower `decision.ratified` (Odin's seat) →
`resource.allocated` → follower `action.attempted` (the `start`, carrying the execution token) →
`resource.executed` (ledger reference) → `outcome.verified` / `outcome.reported`. Each link is an
event or decision id; no text beyond the proposal itself.

## 5. Data and events

### 5.1 ODS tables (ODS spec §6, with §5.3's changes)

`ods.proposals` (granted proposals), `ods.questions` (kind `treasury_ballot`), `ods.votes` (grant and
policy apart), `ods.tallies` (`counts {option: {grant, policy}}`, `turnout_n`, `eligible_n`),
`ods.resources` (a `treasury_day` row per budget day), `ods.allocations` (`proposal_id`). Withdrawal
deletes a resident's proposals and votes in one pass and nulls allocation beneficiaries (ODS spec §6).

### 5.2 Events

| Event | Producer | Stored evidence | Condition | ODS sink (village consent) | Research sink |
|---|---|---|---|---|---|
| `treasury.proposed@1` (reserve) | `plugin` only | `agent_report`; the grant is the follower's `platform_record` | `agent_proposed_human_ratified` | `proposals`, after the grant resolves | research consent; text behind the sanitise gate (Q-T14) |
| `treasury.withdrawn@1` (reserve) | `plugin` only | `agent_report` | | deletes the row | research consent |
| `village.question_opened@1`, `_closed@1` (reserve) | `operator`, later `odin` | `operator_verified` / `agent_report` | | `questions` | village content [NV allowlist] |
| `vote.cast@1` [V registered] | `plugin` only | `agent_report`; grant resolves | grant: `agent_proposed_human_ratified`; policy: `bounded_agent_led` | `votes` | research consent only [V] |
| `tally.closed@1` (reserve) | `operator`, later `odin` | `operator_verified` / `agent_report` | | `tallies` | aggregate, the official result |
| `resource.supplied@1` (reserve) | `operator` | `operator_verified` | | `resources` | village content |
| `resource.requested@1` (reserve) | `odin` | `agent_report` | | `allocations` (`requested`) | yes, no personal data |
| `resource.allocated@1` (reserve) | `odin` (link keys) or `operator` (§4.5) | `agent_report` resolved / `operator_verified` | `agent_proposed_human_ratified` / `human_led` | `allocations` (`allocated`) | beneficiary only under research consent |
| `resource.executed@1` (reserve) | `operator` (§5.3 R3); `control_plane` for top-ups | `operator_verified` / `platform_record` | | `allocations` (`executed`) | as above |
| `decision.*`, `action.*` [V types] | the follower, both seats | `platform_record` | per `condition_v2` | | as today |
| `outcome.verified@1`, `outcome.reported@1` [V types] | `operator`; the proposer's agent | `operator_verified`; `agent_report` | | | research consent |

Votes reach research only for research-consenting residents, so `tally.closed@1` is the result of
record (ODS spec §7). How an outcome names its proposal is [NV]; recommendation: `proposal_id` as the
subject. **Small-n floor**: a public tally with turnout under 5 shows turnout only (ODS spec §3) [NV
the number; Timour]; quorum is higher, so it binds only on display. Research extracts suppress cells
under 5 residents [NV; research owns the rule].

### 5.3 Changes this design asks of the ODS spec draft (PR #191)

| # | Change |
|---|---|
| R1 | `treasury.proposed@1` adds `title`, `beneficiary_kind`, `verify_by`, `origin`; the payload hash covers exactly §2.3's eight fields, not the draft's four |
| R2 | `ods.proposals` adds those columns; `status` adds `not_listed` with an owner-only `status_reason` (`ballot_full`, `recently_funded`, `after_freeze`, `paused`, `ineligible`) |
| R3 | `resource.executed@1` gains an `operator` producer row at `operator_verified`, for payouts |
| R4 | `ods.resources.kind` `treasury_day`; `resource.supplied@1` sets supply absolutely (upsert by `resource_id`), so supply 0 pauses a day |
| R5 | `tally.closed@1.counts` is `{option: {grant, policy}}` like `ods.tallies`; `tally_rule` `treasury_plurality_v1` |
| R6 | Ballot option keys: proposal ids plus `none` and `abstain`; labels "title, N USD", ≤ 80 |

## 6. Surfaces

- **Telegram, proposal card** (the approval bot's `treasury.propose` prompt): title, amount, budget
  day, purpose, beneficiary kind, how it will be verified, "you asked for this" or "your agent
  suggested this", "residents will see your name". No link.
- **Telegram, vote card** (`village.vote`): "Today's treasury ballot", the chosen option's label from
  the ODS, never the agent's words [V `_village_question.py`], the agent's labelled note, close time.
- **Result line**: the ballot job posts once to the village Telegram group after the tally (funded
  titles and amounts, turnout, "awaiting ratification") and once on ratification; never proposers
  or votes [NV the posting route]. A proposer's agent reports status once a hosted feed read exists.
- **The app**: a treasury page or `/insights` section [NV; the app owner]: ballot, proposals with
  proposer names (resident class), results, own proposals and votes; vote card placement is theirs.
- **Skylight**: the public class (ODS spec §8): proposals without proposers, final tallies above the
  floor, funded list, remaining budget.
- **External agents**: tier 1 reads the feed under the human's login; tiers 2 and 3 act only through
  the human in the app, when built: `human_led`, labelled by `agent_kind`.

Residents see turnout, not counts, until close (against bandwagons), and the proposer's name, never
shown publicly [ODS spec Q7, Q6; DECISION NEEDED: Timour on both; recommendation: as stated].

## 7. The experiment design

### 7.1 Hypotheses in testable form

Thresholds are [NV; Timour].

- **H1 (coordination).** At least 0.6 of funded proposals become verified useful outcomes (M8, M9),
  and agent-suggested (`origin = inferred`) ones at a rate not lower than resident-stated ones.
  Refuted if the rate is under 0.6 or the inferred rate is lower by more than its interval.
- **H2 (safety).** Under §2.4's caps the top decile of residents holds at most 30% of funded USD
  (M7) and the Gini over eligible residents stays under 0.8 (M5). Refuted if either is crossed.
- **H3 (delegation).** Policy votes would not change the funded set on most days (M10), and
  residents decline under 20% of agent drafts (M11): descriptive tests of representation.

### 7.2 Observed conditions (per act, never assigned)

| Act | `human_led` | `agent_proposed_human_ratified` | `bounded_agent_led` | `unknown` |
|---|---|---|---|---|
| Proposal | app form (tier 2, when built) | hosted agent draft plus tap | never: no autonomous option | link unresolved |
| Vote | app vote (when built) | draft plus tap | S2 `answer` (recorded, not counted) | link unresolved |
| Allocation | operator fallback (§4.5) | Odin's request plus Timour's tap | pre-authorisation (not in October) | bare token |

`origin` is the plugin's claim at `agent_report`: a label inside `agent_proposed_human_ratified`,
never a condition, since what the resident said is in the archive, not in an event.

### 7.3 Measures

| Id | Measure | Definition |
|---|---|---|
| M1 | Participation | counted voters / `eligible_n` per ballot; also all voters including policy |
| M2 | Proposals per day | listed proposals per ballot, and per 100 eligible residents |
| M3 | Funded share | funded / listed; funded USD / 250 |
| M4 | Time to decision | draft to tap (proposals, votes); close to ratification; ratification to execution |
| M5 | Concentration | Gini of funded USD over all eligible residents, zeros included, over the 14 days |
| M6 | Exhaustion | days with under 10 USD left; lapsed USD per day |
| M7 | Capture | top decile's share of funded USD; residents funded twice or more |
| M8 | Outcome verification | funded and executed proposals with `outcome.verified` within 7 days of the activity / funded |
| M9 | Usefulness | proposer's outcome answer `useful` or `met`; voters' satisfaction (Q-T17) |
| M10 | Policy-vote divergence | days where counting policy votes changes the funded set |
| M11 | Draft decline rate | declined `treasury.propose` and `village.vote` requests / requested, by `origin` |
| M12 | Principal override | ratification declines or lapses / funded (research owns every definition: catalogue rows, Q-T19) |

### 7.4 Confounds and what is not claimable

No assignment, no control arm: every comparison is between self-selected groups (who chooses
`answer`, who proposes). Time: novelty decay over 14 days, weekdays, the fallback-to-Odin switch.
Small n: at most 14 ballots and a few dozen funded proposals, so descriptive results with intervals,
no significance claims. The research subset is smaller than the voting population. Verification
depends on operations' effort. Money changes behaviour: treasury traffic lifts engagement measures
from Oct 18, so a week-1 versus week-2 difference is not a treasury effect. Not claimable: that
agents caused an outcome, that the treasury is efficient, that results generalise past this cohort.

### 7.5 Minimum viable week-2 version

**Keep**: the reservation (§9.1); the ODS writer for the treasury tables; the `treasury_propose`
tool, a ballot-reading vote provider and the 12:05 job; the ballot job and `treasury_plurality_v1`;
the operator fallback; caps; the kill switch; outcome verification; the group result line.
**Cut in this order if late**: MoralMod input; the app page (Skylight and the group line stand
in); Odin's seat (the fallback runs throughout, allocations `human_led`); voters' satisfaction; the
tier-2 form and tier 3 (no `human_led` proposals, stated in the analysis); the start (Oct 21, 11 days).

## 8. Safety and abuse

| Risk | Control |
|---|---|
| Spam proposals | one live proposal per resident; 10 per ballot; one inferred draft a day; tier 3 adds per-human budgets (DATA-290) |
| Sybil votes | one vote per `edgeos_ref`; no counted vote without one; team tenants excluded |
| Collusion and vote trading | single choice; one funded proposal per resident per 7 days; turnout-only running counts; M7 and Odin's flags surface blocs; Timour may decline |
| An agent proposing for its own resident again and again | every proposal needs a tap; one inferred draft a day; none after a same-day decline; M11 measures it |
| Proposal text aimed at other agents ("vote for me") | the text rule; labels from the ODS, not agents; every counted vote is a human tap; the skill treats feed text as data |
| Odin's blast radius | Odin only files requests; per allocation ≤ 100 USD, per day ≤ 250, total ≤ 3,500; the writer refuses `resource.allocated` above the proposal amount or the day's remaining; operations pays only against resolved rows |
| Self-dealing through inference | top-ups are out of the treasury (§2.1) |

**Kill switch**, data-side, no roll: an operator cancels the ballot (`village.question_closed@1`,
`cancelled`) and zeroes remaining supply (`resource.supplied@1`); Timour declines pending requests.
Last resort, Carter's hand: the overlay's treasury switch off (a variable change and a restart).

**When something is refused**: before the tap, the agent says in one plain line why it cannot file
(over the cap, a live proposal already, past the freeze, ballot full, paused, not eligible) and
files nothing. After the tap, an unlisted proposal shows `not_listed` and its reason on the
resident's own feed rows (§5.3 R2), and the agent says so.

## 9. Sequence

### 9.1 Before Oct 11: the reservation (exact)

1. **Resident policy template** (control plane `templates/resident-approval-policy.md`): §3's
   `treasury.propose` row, `village.vote` comment and header line; `tests/approval-policy.test.js`.
2. **Settings page copy** (control plane `SWITCHES`, the app's review page): §3's S2 intro, `answer`
   and `abstain` copy and the fixed `treasury.propose` statement. No switch, no `@2` review event.
3. **Event types** (data repo, ODS spec §7 plus R1 to R6): `treasury.proposed@1` (eight fields),
   `treasury.withdrawn@1`, `village.question_opened@1` and `_closed@1` (kind `treasury_ballot`),
   `tally.closed@1`, `resource.supplied@1`, `.requested@1`, `.allocated@1`, `.executed@1` (with the
   `operator` row), producer class `odin` and its migration. Data-side, no roll.
4. **ODS consent sentence** (ODS spec §10 item 3) names treasury proposals (residents see the
   proposer's name, the public does not) and votes (counted, never shown to others).
5. Not reserved, on purpose: Odin's seat (its own policy, no tenant amendment); the overlay tools
   and scheduled job (a batched post-launch roll); `resource.request` on resident seats (ODS Q12).

### 9.2 Week 1 (Oct 12 to 17): dependencies

ODS service, schema, writer, per-sink routing, retention (ODS spec §10 tasks 1, 5 to 8); §2.4 and §8
writer rules; the tally function; the ballot job; the overlay's `treasury_propose` tool, a
multi-question vote provider (weekly question and daily ballot open together) and the scheduled job,
in the batched roll; the result-line route; Odin's seat (DATA-255) if it fits, else the fallback.

### 9.3 Week 2 go-live checklist and acceptance (team tenants, a `treasury_test` resource)

Go-live: every step passes, Timour signs §2 and §7, the first real `resource.supplied@1`, an
announcement the day before.

1. An agent drafts a proposal; the card shows every §2.3 field; a tap writes `ods.proposals`, a
   decline nothing; a second proposal while one is live is refused before any tap.
2. The ballot lists granted proposals in grant order, at most 10; an eleventh ends `not_listed`
   (`ballot_full`) and its owner sees that.
3. Two residents vote by tap, one by policy: the tally shows them apart, only taps decide, and
   turnout below quorum funds nothing (the test quorum is lowered for the fixture).
4. `tally.closed@1` reaches research; the public class shows turnout only below 5.
5. A funded proposal yields one `resource.allocate` request; a tap makes it `allocated`; a decline
   or a lapse ends it `not_funded`.
6. The operator's `start` and `resource.executed@1` complete §4.6's chain with no gap.
7. A village-consent withdrawal deletes the resident's proposals and votes in one pass and nulls
   the allocation's beneficiary.
8. The kill switch cancels an open ballot and zeroes supply; the agent tells a proposer it is paused.

### 9.4 Who signs what

Timour: rules (§2), research questions and hypotheses (§1, §7), his Q-T items. Seref: nothing unless
Index becomes involved (say, funded proposals published as Index intents). The app owner: vote card
placement and the treasury page. Carter: the data decisions and §5.3's ODS spec changes.

## 10. Open questions

| # | Question | Recommendation | Decides |
|---|---|---|---|
| Q-T1 | Is the 250 USD daily line real, for which days, funded by whom | 14 days, Oct 18 to 31, 3,500 USD, Edge City's account | Timour |
| Q-T2 | Ballot form | single choice plus `none` and `abstain` | Timour |
| Q-T3 | Do policy (`answer`) votes count for funding | no: recorded and published apart | Timour |
| Q-T4 | Quorum and support thresholds | max(10, 15% of eligible); at least 3 votes and more than `none` | Timour |
| Q-T5 | Amount caps and funding frequency | 10 to 100 USD; one funded per resident per 7 days | Timour |
| Q-T6 | Daily times | freeze 11:00, ballot 12:00 to 21:00 IST | Timour |
| Q-T7 | Who may vote in week 2 | hosted-agent residents only; app votes when tier 2 or 3 exists | Timour |
| Q-T8 | Team tenants | excluded from proposing and counted votes | Timour |
| Q-T9 | Inference top-ups through the treasury | no, separate pool (base §6) | Timour |
| Q-T10 | Proposer named to residents (ODS spec Q6) | yes, never public | Timour |
| Q-T11 | Running counts (ODS spec Q7) | turnout only until close | Timour |
| Q-T12 | `treasury.propose` as a fixed row or a switch | fixed manual row and a statement | Carter |
| Q-T13 | Operator fallback before Odin's seat | yes, labelled `human_led` | Carter |
| Q-T14 | Proposal text in the research database | yes, behind the sanitise gate, as digests | Carter |
| Q-T15 | ODS spec changes R1 to R6 | accept into PR #191 | Carter |
| Q-T16 | A deputy approver on Odin's seat | none in week 2 | Timour |
| Q-T17 | Voters' satisfaction | one weekly survey item, not a daily evening line, to spare attention | Timour (research) |
| Q-T18 | Vote card placement and the treasury page | the app owner's call | the app owner |
| Q-T19 | Catalogue rows for M1 to M12 and the treasury primary measure | add as `T.*` rows | Timour (research) |
| Q-T20 | Payment deadline and INR handling | 10 days after the budget day, no later than Nov 3 | Timour |
| Q-T21 | A declined vote draft locks the ballot key (DATA-99 (c)) | a per-attempt key suffix, matched by the writer; until then ask in chat first | Carter |

## 11. Follow-up build tasks to file

| # | Title | One line | Repo |
|---|---|---|---|
| 1 | Reserve `treasury.propose` in the resident policy template | §9.1 items 1 and 2; before Oct 11 | `controlplane`, the Edge City app |
| 2 | Register treasury and resource event types with R1 to R6 | §9.1 item 3, tests; before Oct 11 | `agentvillage-data` |
| 3 | Amend the ODS spec draft with R1 to R6 | §5.3 into PR #191 | `agentvillage` |
| 4 | Tally function `treasury_plurality_v1` | pure function and fixtures for §2.7 | `agentvillage-data` |
| 5 | ODS writer: proposals, ballots, votes, tallies, treasury allocations | §2.4 checks, `not_listed`, ceilings of §8 | `agentvillage-data` |
| 6 | Ballot job | freeze, open, close, tally, result line, kill switch; `operator` token | `agentvillage-data` |
| 7 | Overlay `treasury_propose` tool | propose, withdraw, refusal lines of §8, card fields | `agentvillage` |
| 8 | Overlay multi-question vote provider and the 12:05 job | weekly question and daily ballot from the feed; cron name list v2 | `agentvillage` |
| 9 | Odin's seat and `resource.allocate` requests | DATA-255 service, §3 policy, §4.2 requests | `controlplane`, `agentvillage-data` |
| 10 | Payout runbook and `resource.executed` operator script | `start` with the token, ledger reference, deadlines | `agentvillage-data` |
| 11 | Treasury outcome verification | operator `outcome.verified` against `verify_by`; proposer's outcome question | `agentvillage-data`, `agentvillage` |
| 12 | Treasury marts and catalogue rows | M1 to M12, the primary measure, small-n suppression | `agentvillage-data` |
| 13 | Skylight treasury view | public-class ballot, tallies, funded list, remaining budget | `Edge-City/skylight` (Timour) |
| 14 | App treasury page | resident-class view, own proposals and votes | the Edge City app (its owner) |
| 15 | Treasury acceptance on team tenants | §9.3, evidence in the task | `agentvillage-data` |
