# The village treasury experiment: design

Status: design draft v2 (2026-10-05), task DATA-292. Owner: Carter. v2 rebuilds v1 around Carter's
inputs of 2026-10-05 (approval voting, quorum 20, 150 USD a day and 800 USD on Fridays, one winner a
day, app first, agents suggest) and puts the preregistration first. Base: the ODS spec draft
(`operational-datastore-spec.md`, DATA-291, PR #191: "ODS spec §n"), the approval settings spec
(`approval-settings.md`, DATA-322: "settings spec §n") and `docs/design/operational-datastore.md` v3
in `agentvillage-data` ("base §n"). Marks: [V] verified against code or a decision record, [NV] not
verified, [DECISION NEEDED: who] open, with a recommendation. Nothing here is built or live until
§17.3's acceptance passes on the team tenants.

**The point.** The village budget is a scarce resource that humans and agents have opinions,
intents and actions about. Each day an amount unlocks; residents propose how to spend it and
upvote proposals; at the end of the day proposals lock and one proposal wins the money, or the money
rolls to the next day. Agents never vote or spend on their own in October: they suggest, their
resident taps. The one thing the experiment assigns is *when* an agent suggests. Sections 1 to 8
are the preregistration, to paste into aspredicted.org one box each; 9 onward are the mechanics.

---

## 1. Data collection: have any data been collected for this study already?

No. No data have been collected. The treasury opens on Sunday 18 October 2026 (first unlock) and this
preregistration is filed before that unlock. Test runs on the organisers' own team accounts before
that date are fixtures, not data, and are excluded. [DECISION NEEDED: Carter and Timour, who files
it on aspredicted.org and under whose name; recommendation: Carter files, Timour co-author.]

## 2. Hypothesis: what is the main question being asked?

Main question: when a person's AI agent suggests a concrete treasury action on some days and stays
quiet on others, does the person take part in a shared-budget decision more often, and do the
proposals agents originate fare as well as the ones people write themselves?

Setting: residents of a three-week residential village (Agent Village, Edge City, Goa, India) share a
daily budget (150 USD most days, 800 USD on Fridays, 1,700 USD a week). Any resident may propose a
use (title, description, amount, purpose, beneficiary) and upvote any number of proposals, one vote
per proposal (approval voting). At the end of each day the proposal with the most votes wins its
amount if at least 20 distinct people voted that day; otherwise the money rolls to the next day.
Each resident has a personal AI agent. On randomly assigned "suggestion days" the agent sends one
message at a fixed time with a draft proposal or a draft vote, which the resident approves or
declines with one tap; on "quiet days" it sends nothing about the treasury unless asked.

- H1 (confirmatory). A resident is more likely to participate (cast at least one vote or file at
  least one proposal) on a suggestion day than on a quiet day.
- H2 (confirmatory, non-inferiority). Proposals filed through an agent's suggestion and the
  resident's tap are funded at a rate not lower than proposals residents enter themselves, by more
  than 10 percentage points.
- H3 (exploratory). The share of days that reach a quorum of 20 voters rises from the first week to
  the second.
- H4 (exploratory). Allocation stays unconcentrated: the top decile of beneficiaries receives less
  than half of the two-week total allocated.

## 3. Dependent variables: describe the key dependent variables and how they are measured

All variables are computed from the village's event log (research database) and its operational
datastore, both written by the system, not self-reported. A "day" is a budget day: from unlock at
08:00 to lock at 21:00 India Standard Time.

- Participation (H1), per resident per day: 1 if the resident cast at least one vote (on any
  proposal or on "save it for tomorrow") or filed at least one proposal during that day's window,
  through any channel (the app directly or by tapping an agent's suggestion), else 0. Source: events
  `vote.cast@1` and `treasury.proposed@1` keyed to the resident and the day's ballot. A proposal
  later withdrawn still counts; a suggestion the resident declined does not.
- Funded (H2), per proposal: 1 if the proposal won its day at lock, else 0, before any later
  veto or payment. Source: the day's `tally.closed@1` (winner) and the proposal's channel. Channel
  is fixed by which system recorded the proposal: the resident's agent after the resident's tap
  (agent-originated; observed condition `agent_proposed_human_ratified`) or the app directly
  (human-originated; `human_led`). The agent channel includes proposals the resident asked the
  agent to draft outside a suggestion message; secondary analysis (e) in 8 splits them out.
- Quorum reached (H3), per day: 1 if at least 20 distinct residents voted that day, always judged
  against 20 even if the operating quorum changes (see 8). Also the count of distinct voters.
- Concentration (H4), over the 14 days: the share of total allocated USD received by the top
  ceil(0.1 x B) beneficiaries, where B is the number of distinct beneficiaries who received anything,
  ranked by amount received. Beneficiaries are as named on the winning proposals (a person, a
  vendor, a charity, "the village"). Also reported: the Gini coefficient over beneficiaries.

## 4. Conditions: how many and which conditions will participants be assigned to?

One within-person factor with two levels, assigned per resident per day: suggestion day or quiet
day. Every resident experiences both.

- Suggestion day: once, at 12:00 IST, the agent sends one message: the day's available amount, the
  number of open proposals and their titles (no descriptions or other text written by others), and
  one draft: a proposal for the resident, or an upvote on one listed proposal, or (when the
  resident's own proposal is open) withdrawing it. The resident approves or declines it with one
  tap. Nothing is filed without the tap.
- Quiet day: no treasury message. The agent still helps if the resident raises the treasury.

Assignment is blocked by week (Sun 18 to Sat 24 October; Sun 25 to Sat 31 October) and balanced per
resident: in each week a resident gets 3 or 4 suggestion days, 4 in one week and 3 in the other by a
fair coin, 7 of 14 in all. The days are drawn by a seeded random permutation per resident and week,
computed from a secret seed whose SHA-256 is recorded here [the hash, before filing] and revealed with
the results. Residents who join after 18 October are assigned by the same procedure from their first
day. Residents are told, at consent, that their agent may suggest treasury actions on some days; they
are not told which days until the end. Everything else (who proposes, who votes, through which
channel) is observed, not assigned.

## 5. Analyses: specify exactly which analyses you will conduct

- H1: a mixed-effects logistic regression of participation on a suggestion-day indicator, with a
  random intercept per resident and a fixed effect per day (14 days, which absorbs the Friday amount
  and time trends): logit P(participate) = a_resident + g_day + b x suggestion. Fit by maximum
  likelihood (R lme4 `glmer`, Laplace approximation). H1 is supported if b > 0 with a two-sided
  p < .05 (Wald test). Analysis by assigned condition (intention to treat), whether or not the
  message was delivered. Report the odds ratio with 95% CI and the average marginal effect. If the
  model fails to converge, fit the same model by GEE (logit link, exchangeable correlation,
  clustered by resident) and report that instead.
- H2: among proposals listed at lock on days that reached quorum, the difference in funded rate,
  agent-originated minus human-originated, with a confidence interval clustered by day (wild
  cluster bootstrap, Rademacher weights, 9,999 draws, since there are at most 14 clusters).
  Non-inferiority holds if the lower bound of the one-sided 95% interval (the two-sided 90% CI) is
  above -0.10. An interval that crosses -0.10 is reported as inconclusive, not as refuting.
- H3: quorum reached in week 1 versus week 2 (counts of days), and a Poisson regression of distinct
  voters per day on day index with a Friday indicator. Descriptive; no confirmatory test.
- H4: the top-decile share and the Gini, reported against the 0.5 line. Descriptive.

## 6. Outliers and exclusions

- No outliers are removed. No observation is trimmed or winsorised.
- Excluded residents: the organisers' team accounts; any resident who withdraws consent (their data
  are deleted and they leave every analysis); residents without research consent (their acts count
  toward the live quorum and tally but are not in the analysis data).
- Excluded days: any day the operator paused the treasury (a recorded pause event), for every
  analysis.
- Days that did not reach quorum count for the participation measures (H1, H3) and are excluded
  from the allocation measures (H2, H4).
- Resident-days before a resident's consent or after their withdrawal or departure are not
  observations.

## 7. Sample size: how many observations will be collected?

Every consenting resident with an agent (excluding team accounts) on every budget day from 18 to 31
October 2026: 14 days. There is no target number of residents; the sample is whoever is enrolled.
Stopping rule: the last lock, 21:00 IST on 31 October 2026, the end of the village's treasury. No
interim analysis: until then nobody computes participation or funding by condition; operational
dashboards show pooled figures only.

## 8. Other: anything else to preregister?

- One permitted rule change. The quorum is 20 distinct voters in week one. If fewer than two of the
  first seven days (18 to 24 October) reach quorum, the quorum becomes 12 from 25 October, recorded as
  a dated rule change. No other rule changes. H3 is judged against 20 throughout.
- Execution of payments may change once, from 25 October, from manual payment by Edge City
  operations to a held card or a multi-signature wallet; it changes how a winner is paid, not who
  wins. Recorded as a dated change if it happens.
- Tie rule: if two proposals tie on votes, the earlier-submitted one wins. A proposal must have
  more votes than "save it for tomorrow"; a tie with it rolls the money.
- Secondary measures: (a) time from 12:00 IST to the resident's first vote that day, on suggestion
  days and quiet days (a Cox model with the same day effects, clustered by resident); (b) the share
  of agent-originated proposals later withdrawn, against human-originated ones; (c) the decline
  rate of agent suggestions by kind (proposal, vote, withdrawal); (d) delivery rate of the
  suggestion message (treatment fidelity); (e) H2 with the agent channel split by origin: drafts
  from a suggestion message against drafts the resident asked for; (f) H1 per protocol (delivered
  messages only).
- Exploratory: who wins (person, vendor, charity, village), self-beneficiary proposals, vote
  timing, executed and verified outcomes (the winner happened as proposed), vetoes.
- Debrief: after 31 October each resident is told which of their days were suggestion days.

## 9. Why, and what it serves

The research framing's "bounded representation" module ("informing the allocation of a shared
fund"): one scarce pool, one daily decision, every act attributable to a channel (the app, or an
agent's suggestion and its tap). Its two hypotheses: **coordination** (H1, H2) and **safety** (the
pool is as safe as its rules: H3, H4, §16).

| Research question (`research/overview.md`, data repo) | What the treasury contributes |
|---|---|
| RQ1 Collective behaviour (capture, collusion, exclusion) | H4 concentration, self-beneficiary wins, voting blocs, quorum failure |
| RQ3 Delegation and ratification | decline rates of agent suggestions by kind; withdrawals; vetoes |
| RQ4 Human outcomes | whether a winner is executed and verified as proposed (secondary) |
| RQ5 Comparative performance | H2: agent-originated against human-originated proposals; H1: assigned nudges |
| RQ2 Negotiated coordination | not served: no agent-to-agent negotiation here |

## 10. The rules

### 10.1 Budget schedule

| Day (Asia/Kolkata) | Unlocks |
|---|---|
| Sun to Thu, Sat | 150 USD |
| Fri (Oct 23, Oct 30) | 800 USD |
| A week (Sun to Sat) | 1,700 USD |
| Oct 18 to Oct 31 (14 days) | 3,400 USD at most |

Carter set the schedule [DECISION NEEDED: Timour, that the 3,400 USD line exists and who funds it].
His worked example's 250 USD Monday is replayed under both numbers in §10.6. USD in records (whole
dollars); paid in INR at operations' rate, kept on its ledger [NV]. No proposal funds OpenRouter
credit (base §6's pool) [DECISION NEEDED: Timour; recommendation: keep apart].

**The pot.** Available on day D = everything unlocked through D minus everything allocated before D.
So unspent money rolls automatically: a day without quorum, a vetoed winner or a winner smaller
than the pot all carry the remainder to D+1. A paused day's unlock still accrues. What remains after
the Oct 31 lock lapses to Edge City [DECISION NEEDED: Carter; recommendation: lapse, announced].

### 10.2 The daily cycle (IST)

| Time | Step | Who |
|---|---|---|
| D 08:00 | unlock: supply raised by the day's amount; the day's ballot opens with the pot shown | the day job |
| 08:00 to 21:00 | proposals entered and upvoted, in the app or by tapping an agent's suggestion | residents |
| D 12:00 | suggestion-day residents get their agent's one message (§11.3); quiet-day residents nothing | overlay scheduled job |
| D 21:00 | lock: no new proposals, votes or withdrawals; tally by `treasury_approval_v1` | the day job |
| by D 21:15 | result: `tally.closed@1`; winner or "rolled"; the app's past-days view updates | the day job (Odin later) |
| by D 21:30 | one `resource.allocate` request for the winner | Odin, or the operator fallback (§13) |
| D+1 12:00 | the principal's veto window ends; no answer means ratified | Timour |
| within 48 h of lock | Edge City operations pays; `resource.executed@1` with a receipt reference | operations |

The window sits outside the approval relay's quiet hours (23:00 to 08:00 IST [V, the policy
template]). Times [DECISION NEEDED: Carter]. A proposal and its votes live one day: at lock every
proposal ends (funded, not funded, or withdrawn); a loser may be entered again the next day, with
no votes carried [DECISION NEEDED: Carter; recommendation as stated, so each day's quorum is that
day's people].

### 10.3 Who may propose and vote

- **Eligible**: a resident with a hosted agent, village consent in force (ODS spec §2.3) and a
  resolved `edgeos_ref` (ODS spec §6); not a team tenant. One EdgeOS identity, one voter. The ODS
  keys people by tenant [V ODS spec §6], so attendees without a hosted agent read but do not act;
  letting them vote needs a non-tenant person row [DECISION NEEDED: Carter; recommendation: not in
  October].
- **Not**: Odin, operators, MoralMod, external agents (tier 1 reads only; tiers 2 and 3 of DATA-290
  are not built [V]), team tenants (they run it).

### 10.4 Proposal shape

| Field | Rule |
|---|---|
| `proposal_id` | lower-case UUID, minted by the plugin or the control-plane route |
| `title` | ≤ 80 characters, the digest text rule; the label everywhere |
| `text` (description and purpose) | ≤ 500 characters, the digest text rule: what, where, when, for whom |
| `amount_cents` | whole dollars, 1 USD up to the pot at entry |
| `beneficiary` | ≤ 80 characters: who is paid (a person, a vendor, a charity, or "the village") |
| `beneficiary_kind` | `person`, `vendor`, `charity`, `village` |
| `budget_day` | the open day; nothing is filed for a future day |
| `channel` | `app` or `agent`, set by the producer, never by the proposer |
| `origin` | agent channel only: `nudge` (from the suggestion-day message) or `asked` (the resident asked) [NV that the plugin can tell a scheduled run from a foreground turn; DATA-312 does] |

A person may be the beneficiary, the proposer included: votes are the check (Carter's example). No
payment details enter a proposal, an event or the ODS: operations collects them at payment. No
links, no attachments. One open proposal per resident per day (withdraw to replace); at most 40 open
proposals a day [NV the number], after which entry is refused with "today's list is full".

### 10.5 Voting and the tally: rule `treasury_approval_v1`

Approval voting: a voter upvotes any number of the day's open proposals, one vote per proposal, and
may upvote **"Save it for tomorrow"** (option `none`). Upvoting one's own proposal is allowed. Votes
are final once cast [DECISION NEEDED: Carter; recommendation: final, with a confirm step, so no
retraction event is needed in October]. At lock:

1. Counted votes: one per (voter, option); options are the day's proposals still open at lock, and
   `none`; authorisation `grant` (an agent suggestion the resident tapped) or `direct` (the app).
   `policy` votes are never counted (§11.2).
2. Voters = distinct residents with at least one counted vote. Fewer than the quorum (20; 12 after
   the one permitted change, §8): no winner, the pot rolls.
3. The leading proposal by counted votes wins if it has strictly more votes than `none`. Ties
   between proposals: the earlier `proposed_at` wins (then the smaller `proposal_id`). A tie with
   `none`, or `none` ahead: no winner, the pot rolls.
4. The winner is allocated its own amount; the rest of the pot rolls; every other proposal ends
   `not_funded` (reason `outvoted` or `no_quorum`).

One pure function in `agentvillage-data`, named in `tally_rule`; the day job and Odin call it and
neither chooses. Single winner, one rule for the whole village, no switch. **Future variant, not
this village**: proportional splits above a vote threshold, as a different village's arm.

### 10.6 Carter's example, replayed

- **Monday Oct 19** (rule: pot 150 USD if Sunday rolled nothing; example: 250 USD). Carter proposes
  50 USD for village karaoke; Timour proposes 60 USD for a local charity; the app owner upvotes
  Timour's; with Carter and Timour each upvoting their own, 3 voters. Below 20: no winner; the pot
  rolls; both proposals end `not_funded` (`no_quorum`).
- **Tuesday Oct 20**: pot 300 USD (150 rolled plus 150; example: 400). Carter proposes 300 USD to his
  own bank account (`beneficiary_kind: person`). The app owner proposes 300 USD to buy everyone drinks
  (`person`, the app owner). 20 residents upvote the app owner's; quorum met; it beats Carter's and
  `none`; 300 USD allocated; 0 rolls (example: 100 rolls). Within 48 hours operations reimburses the
  app owner against the bar's receipt; the receipt reference appears on Tuesday's row.

## 11. The agent dimension

### 11.1 Classes and flows

| Class | The agent suggests | The resident | Event on tap | Settings values (settings spec §2) |
|---|---|---|---|---|
| `treasury.propose` | a draft proposal (all §10.4 fields) | approves or declines | `treasury.proposed@1` (`plugin`, grant) | ask, never [V row reserved] |
| `village.vote` | an upvote on one listed proposal, or on `none` | approves or declines | `vote.cast@1` (`plugin`, grant) | ask, autonomous, never [V] |
| `treasury.withdraw` | withdrawing a proposal the resident submitted | removes or declines | `treasury.withdrawn@1` (`plugin`, grant) | ask, never (new, §15.3 S1) |

The card shows exactly what is filed (the `_share_vote.py` rule: one canonical string, RFC 8785,
hashed) [V pattern]. Keys: `treasury.propose:<proposal_id>`, `treasury.withdraw:<proposal_id>`,
`village.vote:<question_id>:<answer>:<tenant>` on treasury ballots, so a declined upvote draft
blocks only that proposal, not the ballot (DATA-99 open item (c)) [NV that plugin and writer accept
the longer key]. A resident may also withdraw their own proposal in the app before lock
(`control_plane`, `direct`); withdrawing voids its votes, and voters may upvote others.

### 11.2 No autonomous treasury acts in October

`village.vote` offers `autonomous` for the weekly question. A treasury upvote granted by policy
would be an autonomous treasury act, so: the ODS writer stores no `policy` vote on a
`treasury_ballot` (recorded in research as `vote.cast@1` with `policy`, never counted), and a
suggestion-day message to a resident whose `village.vote` is `autonomous` carries a proposal or
withdrawal draft, never a vote draft. `treasury.propose` and `treasury.withdraw` offer no
autonomous value. [DECISION NEEDED: Carter; alternative: a fourth reserved class `treasury.vote`
(ask, never) that keeps the weekly question's autonomy apart; recommendation: the rule above, since
it needs no new class before Oct 11.]

### 11.3 The suggestion-day message (the one assigned condition)

The overlay's scheduled job `treasury-nudge` runs at 12:00 IST on every resident tenant. It reads
today's arm from the ODS owner slice `my_treasury_day` (§15.3 R10). **Quiet**: it exits with no model
call and no message. **Suggestion**: one model run, one message, one draft at most, then
`treasury.suggested@1`.

- **Content rule.** The message carries the pot, the lock time, the count of open proposals and
  their titles, verbatim from the ODS; no description, beneficiary or other free text written by
  someone else. The scheduled run's prompt gets titles and amounts only, so third-party descriptions
  never enter it. The agent's reason for its draft is one line, labelled as the agent's.
- **Which draft.** In order: an upvote on a listed proposal (or `none`) the agent can ground in what
  the resident has told it; else a proposal draft from something the resident stated; else, if the
  resident's own open proposal duplicates another listed one, a withdrawal draft; else no draft (the
  message alone). Every case counts as delivered (intention to treat).
- **One message.** No follow-up that day; a decline ends it. Whatever the resident answers in chat
  afterwards is an ordinary conversation (`origin: asked` from then).
- **Quiet days.** The skill tells the agent to raise the treasury only when the resident does. Its
  requests on quiet days carry `origin: asked`. Leakage (an unprompted suggestion on a quiet day) is
  checked on a sample of archive text for research-consenting residents [NV the sample size; research
  owns it]. The plugin never computes the arm (§11.4).

### 11.4 Randomisation

- `treasury_assign_v1(seed, resident_ref)`: coin = low bit of HMAC-SHA256(seed, ref || "coin"): 4
  suggestion days in week 1 and 3 in week 2 if 1, the reverse if 0. For week w, a Fisher-Yates
  shuffle of its 7 dates driven by HMAC-SHA256(seed, ref || w); the first k_w dates are suggestion
  days. Deterministic, so a late joiner gets the same procedure (days before consent are not data).
- A script in `agentvillage-data` (commit SHA recorded) writes the table on Oct 17 to
  `ods.treasury_assignment` and research, and prints the seed's and the table's SHA-256 for §4.
- The seed is a Railway variable on ingest, `TREASURY_ASSIGN_SEED` (name only), set by Carter (his
  hands), revealed after Nov 1 [DECISION NEEDED: Carter, custody]. No outcome by arm before Oct 31.

### 11.5 What residents are told

- **Village consent sentence** (ODS spec §10 item 3), added before Oct 11: "From 18 October the
  village has a daily budget. On some days, chosen at random, your agent may suggest a treasury
  proposal or vote to you; nothing is filed unless you approve it. Residents see your name on your
  proposals; your votes count but are never shown to anyone." [DECISION NEEDED: Carter, wording;
  [NV] whether research consent at sign-up already covers a randomised suggestion schedule.]
- **Debrief** after Oct 31: each resident sees which of their days were suggestion days.

### 11.6 Template rows and settings copy (before Oct 11)

Resident template (`control-plane/templates/resident-approval-policy.md` and this repo's mirror):

```yaml
  village.vote:      { autonomy: manual, agent_may_request: true }   # weekly question and treasury upvotes, DATA-99, DATA-292
  treasury.propose:  { autonomy: manual, agent_may_request: true }   # DATA-292, from Oct 18
  treasury.withdraw: { autonomy: manual, agent_may_request: true }   # DATA-292, from Oct 18
```

Settings page (settings spec §6 table): `village.vote` becomes "The village question and treasury
votes" / "Answers the weekly question and suggests treasury upvotes for you. Treasury votes always
need your tap."; `treasury.propose` / "Suggests treasury proposals for you to approve.";
`treasury.withdraw` "Withdrawing your treasury proposals" / "Suggests withdrawing a treasury
proposal you made; nothing happens without your tap." Copy is not hashed [V], but its meaning is
consent-shaped: before Oct 11.

## 12. The app: where humans act first

Agent Village app first (`Edge-City/agentvillage-app`; the app owner's call on placement and design
[DECISION NEEDED: the app owner]); EdgeOS later. One treasury page, three views and two actions:

- **Today**: the pot ("300 USD available, locks at 21:00"), voters so far against quorum ("14 of 20
  people have voted"), the open proposals (title, amount, description, beneficiary, proposer's name,
  channel badge "via an agent" or none), and an upvote button on each. Per-proposal counts hidden
  until lock [DECISION NEEDED: Carter; recommendation: hidden, against bandwagons; ODS spec Q7].
- **Past days**: each day's pot, voters, and how it resolved: the winner and amount, or "rolled:
  no quorum", "rolled: save it for tomorrow won", "vetoed: <reason class>"; then payment status and
  the receipt reference once executed.
- **Coming days**: the schedule (150 USD, 800 USD on Fridays) to Oct 31, and the quorum in force.
- **Propose**: a form with title, description, amount, beneficiary and kind; refuses over the pot,
  a second open proposal, after lock. **Withdraw** own proposal before lock.

**Writes** go through the control plane under the resident's EdgeOS login (`POST
/me/treasury/proposals`, `POST /me/treasury/votes`, `DELETE /me/treasury/proposals/:id`) [NV; the
settings routes are the pattern, settings spec §4], each emitting through the outbox
(`control_plane`, `platform_record`, `authorized_by: direct`); ingest stays the ODS's only writer
(ODS spec §2); the app shows a write as pending until the feed confirms it [NV the latency; §17.3
item 2]. **Reads**: the feed, resident class. **Public** (Skylight, ODS spec §8): pot, schedule,
proposals without proposers, results above the small-n floor.

## 13. Odin: the recorder of the day's result

**Inputs** (through `ods_reader_coordination`, ODS spec §4.3): the final tally and the winner
`treasury_approval_v1` computes; the pot; the winner's fields; flags (near-duplicate titles,
self-beneficiary, a burst of votes in the last minutes; never individual votes [V ODS spec §8]); a
MoralMod `recommendation.computed@1` when one exists, evidence only (base §7).

**The request.** One approval.md request, class `resource.allocate`, key
`resource.allocate:<proposal_id>`, payload exactly `{allocation_id, resource_id, proposal_id,
amount_cents, budget_day, tally_question_id}`; the summary carries the tally line, title,
beneficiary kind and flags. Odin cannot pick another winner, change an amount or reorder; it emits
`resource.requested@1` when it files. The chain per winner, each link an event or decision id:
proposed, votes, tally, requested, decision, allocated, executed (receipt), verified.

**Veto, not choice.** The principal, Timour (DATA-255, base §7), may veto by D+1 12:00 IST on
stated grounds only: unlawful, fraud, unsafe, or not executable. No answer ratifies. A veto rolls
the amount to the next unlock; nothing cascades to the runner-up. [DECISION NEEDED: Carter and
Timour, whether a veto exists at all; recommendation: keep it, since a rolled pot can exceed 1,000
USD; every veto is published with its reason class.] Odin's own seat (DATA-255 Railway service [V
B5b]) holds `resource.allocate` at `autonomy: manual`, TTL to the veto deadline, `on_expiry:
approve` [NV that core offers approve-on-expiry; until it does, the fallback runs].

**Fallback before Odin's seat** (DATA-255 is a post-launch build): the day job (`operator` token)
emits the tally, Timour's veto runs by message to Carter, and an operator script emits
`resource.allocated@1`; these read `human_led` [DECISION NEEDED: Carter; recommendation: yes].

## 14. Money: executing the winner

### 14.1 October: operations pays by hand

Edge City operations executes the winner within 48 hours of lock, one of three ways: **vendor
payment** (operations pays the named vendor or charity), **reimbursement** (the beneficiary spends,
then submits receipts; paid up to the amount), **transfer** (to a named person's account). No
automatic payout, no agent or service holds money, keys or credit. Operations collects payment
details off-system and records `resource.executed@1` (`operator`, `operator_verified`) with an opaque
`receipt` reference (its ledger id) that the app's past-days view shows. A winner that cannot be
paid within 7 days (beneficiary unreachable, refused) is `expired` and its amount re-enters the pot
at the next unlock [DECISION NEEDED: Carter]. Operations verifies the funded thing happened
(`outcome.verified@1`) against the proposal's description and the receipt. [NV, before Oct 18;
Timour with operations] Whether Edge City may pay individuals and Indian
charities from its account (Indian foreign-contribution rules, tax on transfers to persons). If
not, `beneficiary_kind` narrows to `vendor` and `village` (and `person` by reimbursement only), and
the consent sentence and app say so before the first unlock.

### 14.2 Week-3 upgrade path (from Oct 25; undecided)

| Option | How | For | Against |
|---|---|---|---|
| A. Status quo | operations pays by hand | no new risk; receipts already work | 48 h lag; operations' load grows with every winner |
| B. Prepaid card held by operations | a card loaded with the week's amount, per-day limit at the day's winner | same-day vendor purchases; spend capped by the card | no transfers to people or charities; issuance and KYC time in India [NV]; still manual |
| C. On-chain multisig | a stablecoin wallet, 2-of-3 signers (operations, Timour, Carter); the winner is one transaction | the transaction hash is a public receipt; minutes, not days; an agent could later draft the transaction for humans to sign | beneficiaries need wallets and an INR off-ramp; Indian crypto tax and reporting [NV]; vendors in Mandrem unlikely to accept; v1 ruled out crypto |

Any change is a dated change under §8 and alters payment only. `receipt` stays an opaque string so
a card reference or a transaction hash fits. [DECISION NEEDED: Carter and Timour, by Oct 22.]

## 15. Data and events

### 15.1 ODS tables (ODS spec §6, with §15.3's changes)

`ods.proposals` (every proposal of every day, both channels), `ods.questions` (one `treasury_ballot`
per day, `question_id` `treasury-YYYY-MM-DD`), `ods.votes` (one row per voter and option),
`ods.tallies`, `ods.resources` (one `treasury` row), `ods.allocations` (`proposal_id`), and the new
`ods.treasury_assignment` (`tenant_id` cascading, `budget_day`, `arm`, `assign_version`) with an owner
view that returns today's row only. Withdrawal of village consent deletes a resident's proposals,
votes and assignment in one pass and nulls allocation beneficiaries (ODS spec §6).

### 15.2 Events

| Event | Producer | Evidence | Condition | ODS sink (village consent) | Research sink |
|---|---|---|---|---|---|
| `treasury.proposed@1` (reserve) | `plugin`; `control_plane` (app) | `agent_report`, grant resolves; `platform_record` | `agent_proposed_human_ratified`; `human_led` | `proposals` | research consent; text behind the sanitise gate (Q-T9) |
| `treasury.withdrawn@1` (reserve) | `plugin`; `control_plane` | as above | as above | deletes the row, voids its votes | research consent |
| `treasury.suggested@1` (new, reserve) | `plugin` only | `agent_report` | the assigned arm's delivery | none | research consent |
| `vote.cast@1` [V registered] | `plugin`; `control_plane` (new row) | as above; `policy` never counted | grant, direct, policy | `votes` (not `policy` on treasury) | research consent only [V] |
| `village.question_opened@1`, `_closed@1` (reserve) | `operator`, later `odin` | `operator_verified` / `agent_report` | | `questions` | village content |
| `tally.closed@1` (reserve) | `operator`, later `odin` | as above | | `tallies` | aggregate, the result of record |
| `resource.supplied@1` (reserve) | `operator` | `operator_verified` | | `resources` | village content |
| `resource.requested@1`, `.allocated@1` (reserve) | `odin`; `operator` (fallback) | `agent_report` resolved / `operator_verified` | `agent_proposed_human_ratified` / `human_led` | `allocations` | beneficiary only under research consent |
| `resource.executed@1` (reserve) | `operator` (new row); `control_plane` for top-ups | `operator_verified` | | `allocations` (`executed`) | as above |
| `outcome.verified@1` [V type] | `operator` | `operator_verified` | | | research consent |

Votes reach research only for research-consenting residents, so `tally.closed@1` is the result of
record (ODS spec §7). The assignment reaches research from the generator, not the feed. Research
extracts suppress cells under 5 residents [NV; research owns the rule].

### 15.3 Changes asked of the ODS spec draft (PR #191) and the settings spec

| # | Change |
|---|---|
| R1 | `treasury.proposed@1` adds `title`, `beneficiary`, `beneficiary_kind`, `origin`; the payload hash covers `{proposal_id, title, text, amount_cents, budget_day, beneficiary, beneficiary_kind}` |
| R2 | `control_plane` producer rows (`platform_record`) for `treasury.proposed@1`, `treasury.withdrawn@1` and `vote.cast@1`; `authorized_by` gains `direct`; `treasury.withdrawn@1` gains optional approval-link keys for the agent path |
| R3 | `ods.votes` keyed `(question_id, tenant_id, answer)`; the writer keeps one answer per voter on `weekly` questions |
| R4 | A `treasury_ballot`'s options are dynamic: `none` at open, plus the day's open proposals by `proposal_id`; the 12-option cap applies to `weekly` only |
| R5 | `ods.proposals` adds `title`, `beneficiary`, `beneficiary_kind`, `channel`, `origin`, `status_reason` (`outvoted`, `no_quorum`, `vetoed`, `withdrawn`); `status` adds `vetoed`; `expires_at` is the day's lock |
| R6 | `ods.resources.kind` `treasury`, one row; `resource.supplied@1` sets supply absolutely (cumulative unlocked), so a pause is "not raised" |
| R7 | `resource.executed@1` gains an `operator` producer row at `operator_verified`; `receipt` is an opaque string |
| R8 | `tally.closed@1.counts` is `{option: {grant, direct, policy}}`; adds `voters_n`, `quorum`, `winner_proposal_id` (nullable), `rolled_cents`; `tally_rule` `treasury_approval_v1` |
| R9 | New reserved type `treasury.suggested@1` (`plugin` only): `suggestion_id`, `budget_day`, `draft_kind` (`proposal`, `vote`, `withdraw`, `none`), the draft's request key, `sent_at` |
| R10 | `ods.treasury_assignment` and the owner slice `my_treasury_day` (arm, pot, open count, titles) |
| R11 | `village.question_closed@1.status` adds `paused` for an operator pause (§6's excluded days) |
| S1 | Settings spec (DATA-322) §2: add the `treasury.withdraw` row (propose, reserved, ask and never, default ask) |
| S2, S3 | Settings spec §6: `village.vote` and `treasury.propose` label and line as §11.6 |

## 16. Safety and abuse

| Risk | Control |
|---|---|
| Spam proposals | one open proposal per resident per day; 40 a day; one suggestion message on a suggestion day only |
| Sybil votes | one voter per `edgeos_ref`; tenant residents only; team tenants excluded |
| Self-dealing (Carter's 300 USD to himself) | allowed and visible: proposer's name, beneficiary and kind on the card; votes decide; veto (§13); H4 and self-beneficiary wins measured |
| Vote trading and blocs | approval voting blunts single-vote trades; counts hidden until lock; Odin's flags; Timour may veto only on stated grounds |
| A large rolled pot | the pot is always shown; quorum; the veto; [DECISION NEEDED: Carter, a per-day ceiling; recommendation: none, so rolls stay meaningful] |
| Proposal text aimed at agents ("upvote me") | titles only reach the scheduled run; descriptions never; text rule on entry; every counted vote is a human tap or a direct app act |
| Agent pressure on its resident | one message, one draft, no follow-up; a decline ends it; quiet-day leakage audited (§11.3) |
| Odin's blast radius | Odin only files a request for the computed winner; the writer refuses `resource.allocated` above the winner's amount or the pot; operations pays only against an allocated row |
| Payment data | never in a proposal, event or the ODS; operations keeps it |

**Kill switch**, data-side, no roll: an operator closes the day's ballot `paused`
(`village.question_closed@1`), does not raise supply, and declines any pending allocation request;
the agent tells a resident "the treasury is paused today". Last resort, Carter's hand: the overlay's
treasury switch off (a variable change and a restart). Paused days are excluded (§6). Refusals
before a tap (over the pot, a second open proposal, after lock, list full, paused, not eligible):
the agent says so in one line and files nothing.

## 17. Sequence

### 17.1 Before Oct 11: the reservation (exact)

1. **Resident template** rows of §11.6 (`treasury.propose`, `treasury.withdraw`, the `village.vote`
   comment) and `tests/approval-policy.test.js`; the mirror under `skills/approval/templates/`.
2. **Settings copy** S1 to S3 (§15.3), in the settings spec's table.
3. **Event types** (data repo, ODS spec §7 plus R1, R2, R7 to R9, R11): `treasury.proposed@1`,
   `treasury.withdrawn@1`, `treasury.suggested@1`, `village.question_opened@1` and `_closed@1`,
   `tally.closed@1`, `resource.*`, the `control_plane` rows and `direct`, producer class `odin`.
   Data-side, no roll.
4. **Consent sentence** of §11.5 in the ODS consent (ODS spec §10 item 3).
5. Not reserved, on purpose: Odin's seat, the overlay's tools and the `treasury-nudge` job (a
   batched post-launch roll), `resource.request` on resident seats (ODS spec Q12).

### 17.2 Week 1 (Oct 12 to 17)

ODS service, schema with R3 to R6 and R10, writer and retention (ODS spec §10); `treasury_approval_v1`
with fixtures; the day job (unlock, lock, tally, pause); control-plane routes and the app page (§12);
the overlay's three tools, the skill text and `treasury-nudge` in the batched roll; the assignment
generator and the seed (Carter); the operations runbook and the `resource.executed` script; Odin's
seat (DATA-255) if it fits, else the fallback. The preregistration filed by Oct 17 with the hashes.

### 17.3 Acceptance on team tenants (a `treasury_test` resource, fixture quorum of 2)

1. The app renders today, past and coming days; a proposal with every §10.4 field is entered; over
   the pot, a second open proposal and after-lock entry are refused.
2. Two upvotes from one resident on two proposals both count; a repeat on one is a no-op; the app's
   pending write confirms from the feed within [NV] seconds.
3. Agent drafts: a proposal card shows every field and a tap files it with `channel: agent`; an
   upvote tap counts; a `policy` upvote is recorded and not counted; a withdrawal tap removes the
   proposal and voids its votes; a decline files nothing.
4. Lock below quorum rolls (next pot = rolled plus new); a tie goes to the earlier proposal; a tie
   with `none` rolls; `tally.closed@1` reaches research.
5. The winner yields one `resource.allocate` request (or the fallback); a veto rolls the amount;
   `resource.executed@1`'s receipt reference shows on the past-days row.
6. A quiet tenant gets nothing at 12:00 and no model call; a suggestion tenant gets one message
   with titles only and one card; `treasury.suggested@1` lands; the table's hash matches.
7. A village-consent withdrawal deletes proposals, votes and assignment; nulls the beneficiary.
8. The kill switch pauses a day; the agent says so; the day is marked `paused`.

**Contingency.** If the agent path (items 3 and 6) has not passed by Oct 17, the treasury opens
app-only on Oct 18; the preregistration is filed before the first suggestion day with the shorter
window, and app-only days are reported apart, never in H1 or H2.

## 18. Open questions (what Carter's inputs did not settle)

Sign-off: Carter, the rules, the preregistration and §15; Timour, funding, the veto and the legal
check; the app owner, the page; Seref, nothing unless Index becomes involved.

| # | Question | Recommendation | Decides |
|---|---|---|---|
| Q-T1 | Is the 3,400 USD line real, and who funds it | yes, Edge City's account | Timour |
| Q-T2 | Who files the preregistration, under whose name | Carter files; Timour co-author | Carter, Timour |
| Q-T3 | Daily times | unlock 08:00, message 12:00, lock 21:00 IST | Carter |
| Q-T4 | Proposals live one day, no votes carried | yes | Carter |
| Q-T5 | Votes final once cast | yes, with a confirm step | Carter |
| Q-T6 | The "save it for tomorrow" option | yes; it is what "a tie with none rolls" needs | Carter |
| Q-T7 | Per-proposal counts hidden until lock (ODS spec Q7) | hidden; voters-against-quorum shown | Carter |
| Q-T8 | Policy votes on treasury ballots, or a fourth class `treasury.vote` | not stored or counted; no new class | Carter |
| Q-T9 | Proposal text in the research database | yes, behind the sanitise gate | Carter |
| Q-T10 | A principal's veto, its grounds and window | yes, four grounds, until D+1 12:00 | Carter, Timour |
| Q-T11 | Operator fallback before Odin's seat | yes, labelled `human_led` | Carter |
| Q-T12 | Unpayable winner within 7 days; leftover after Oct 31 | `expired`, back into the pot; leftover lapses to Edge City, announced | Carter |
| Q-T13 | Paying persons and Indian charities (legal) | check before Oct 18; narrow kinds if blocked | Timour with operations |
| Q-T14 | Week-3 execution upgrade | undecided: A, B or C (§14.2) | Carter, Timour, by Oct 22 |
| Q-T15 | Attendees without a hosted agent as voters | not in October | Carter |
| Q-T16 | Seed custody and reveal | a Railway variable; revealed after Nov 1 | Carter |
| Q-T17 | Consent sentence wording; does research consent cover the schedule | §11.5's sentence; check the research consent | Carter |
| Q-T18 | H2's non-inferiority margin | 10 percentage points | Carter, Timour |
| Q-T19 | ODS spec changes R1 to R11; settings changes S1 to S3 | accept into PR #191 and DATA-322 | Carter |

## 19. Follow-up build tasks to file

| # | Title | One line | Repo |
|---|---|---|---|
| 1 | Reserve treasury classes, copy and event types | §17.1 items 1 to 3; before Oct 11 | controlplane, this repo, `agentvillage-data` |
| 2 | Amend the ODS spec with R1 to R11 and the settings spec with S1 to S3 | §15.3 | this repo |
| 3 | Tally function `treasury_approval_v1` and the day job | §10.5 and §10.6 fixtures; unlock, lock, tally, pause | `agentvillage-data` |
| 4 | ODS writer for the treasury tables | §10.4 checks, dynamic ballots, policy refusal, ceilings | `agentvillage-data` |
| 5 | Assignment generator and owner slice | §11.4, hashes for the preregistration | `agentvillage-data` |
| 6 | Control-plane treasury routes and the app page | §12 | controlplane, `agentvillage-app` (the app owner) |
| 7 | Overlay treasury tools and `treasury-nudge` | three classes, §11.3's content rule, origin labels | this repo |
| 8 | Odin's seat and `resource.allocate` | DATA-255, §13 | controlplane, `agentvillage-data` |
| 9 | Payment runbook and `resource.executed` script | §14.1, 48 h, receipts | `agentvillage-data` |
| 10 | Treasury marts and the preregistered analysis script | §3 and §5 exactly, run once after Oct 31 | `agentvillage-data` |
| 11 | Treasury acceptance on team tenants | §17.3 with evidence | `agentvillage-data` |
| 12 | File the preregistration | §1 to §8 with the hashes, before Oct 18 | Carter |
