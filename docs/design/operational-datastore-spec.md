# The operational datastore: specification

Status: draft spec, v2 (2026-10-06: Carter's rulings applied, §11), task DATA-291. Owner: Carter. Base
note: `docs/design/operational-datastore.md` v3 in
`Edge-City/agentvillage-data` ("base §n"); its decisions stand unless
marked here. Marks: [V] verified against code or a decision record, [NV]
not yet verified, [DECISION NEEDED: who] open, with a recommendation;
questions Carter ruled on 2026-10-05/06 are marked [Decided] (§11). Code
facts were read from `agentvillage-data` `origin/main` on 2026-10-04
(`src/schemas/index.ts`, `src/evidence.ts`, `src/worker/consent.ts`,
`src/jobs/index-poller.ts`, `docs/spec-addenda.md` §4.1,
`tests/ods-share-vote.test.ts`). No `ods.*` table, `ods_*` role,
`resource.*` event or `odin` producer class exists yet [V].

## 1. Purpose and non-goals

The ODS is where village services read shared village state: Skylight,
Odin, the Edge City app, and residents' own agents, hosted or external.
Current state, identified, short-lived, apart from research (base §1, §3).

Goals: one feed, so Skylight, Odin and an external agent see the same
question, proposals and tallies; every row arrives with a consent basis and
leaves on a clock or a withdrawal, whichever is first; and everything the
week-1 and week-2 builds need (event types, producer class, approval
class, consent sentence) is reserved before Oct 11, so the build causes no
policy amendment, re-consent or extra roll (wave-2 plan, Carter: "reserve
now, build later").

Non-goals:

- **No resident memory.** No service reads a tenant's Hermes memory,
  session store or archive through the ODS and no job copies them in; what
  services know of a resident is a digest they approved (base §1).
- **Not a research store.** Nothing here is `platform_record` for research,
  research never reads `ods.*`, and the ODS holds no pseudonymised copies;
  research keeps its own sinks, consent purpose and withdrawal rules.
- **Not a log.** Current state plus tombstones for a bounded window (§5);
  decision history lives in research (`core.decisions`, `core.actions`).
- **No write route for readers.** Every write enters as an event through
  ingest (§2); a human write from outside the hosted fleet passes a
  control-plane route first (DATA-290, tier 3).
- **No text from non-consenting people, no DMs, no media** (base §4).

## 2. Sources and the single writer

Ingest is the only process with DML on the ODS (base §2, §3) [V decision].
DATA-291's "write paths (control plane only)" is read as: readers never
write; a write from outside the hosted fleet enters through a control-plane
route, then the event pipeline; ingest alone writes the store.

### 2.1 Source table

| Source | Event(s) | Producer (token class) | Stored evidence class | ODS consent basis | Table |
|---|---|---|---|---|---|
| Group chat | `telegram.group_message@1`, text via the archive write in the same request | `poller`, source `telegram-group` (DATA-216) | `platform_record` (poller cap) | the group-chat consent sentence (DATA-214 AC #1) and a resolved resident sender | `group_messages` |
| Digests | `digest.shared@1`, `digest.revoked@1` [V registered] | `plugin` only (`PLUGIN_ONLY`) [V] | `agent_report` [V]; the grant's `platform_record` is the follower's `decision.ratified` | a ratified grant in class `digest.share` (addenda §4.1 rule 3) and village consent in force | `digests` |
| Weekly question | `village.question_opened@1`, `village.question_closed@1` (reserve, §7) | `operator`; `odin` once Odin's seat exists | `operator_verified` / `agent_report` | none: village content, no personal data | `questions` |
| Votes | `vote.cast@1` [V registered] | `plugin` only [V] | `agent_report` [V] | a ratified grant, or a recorded policy start, in class `village.vote` (rule 5) and village consent | `votes` |
| Tallies | none in; computed by the writer from `votes`; `tally.closed@1` out (§7) | the writer computes; `odin` or `operator` records | `derived` | aggregate, no personal data | `tallies` |
| Village intents | `intention.captured/updated/withdrawn` from the Index poller [V types]; text from the poller's in-process read | `poller`, source Index | `platform_record` | the resident published it through the village tool (`sourceType = agentvillage`), not incognito, and village consent [Decided, Q4] | `intents_public` |
| Treasury proposals | `treasury.proposed@1`, `treasury.withdrawn@1` (reserve, §7) | `plugin` only; `control_plane` for tier 3 later | `agent_report` | a ratified grant in class `treasury.propose` and village consent | `proposals` |
| Resource registry | `resource.supplied@1` (reserve) | `operator` | `operator_verified` | none: village content | `resources` |
| Allocations | `resource.requested@1`, `resource.allocated@1`, `resource.executed@1` (reserve) | `odin` or `plugin`; `odin` or `operator`; `control_plane` | `agent_report`; `agent_report` / `operator_verified`; `platform_record` | the principals' grant on Odin's seat (Timour and Carter, no automatic approvals, §7) and the beneficiary's village consent | `allocations` |

**Announcements channel** (week 1). A listener reads the village
announcements channel into the ODS and feeds the knowledge snapshot
(CLAIMS 23:50Z). Village content, no personal data; its event and table
are not yet specified [NV]. No other Telegram group or channel is ingested
until DATA-216 is live.

### 2.2 Corrections to the brief and the base note

- **`question.asked/answered` are not village questions.** They are the
  Index poller's types for questions Index asks a resident in their own
  agent DM (`research/partners/index-network/integration.md` §3) [V]:
  personal, never in the ODS. The weekly question (DATA-99 AC #3) gets its
  own types (§7).
- **Digest and vote evidence is `agent_report`.** Base §5 expected
  `platform_record`; the schemas cap the plugin at `agent_report` and the
  grant's strength lives on the follower's decision (addenda §4.1) [V]. The
  writer resolves (rules 3 to 10) before writing.
- **Group-message text is not in the event.** DATA-216 sends structure in
  the event and text to the archive write [V task]; the ODS writer takes
  the text from that same request. The type is not registered yet [V].
- **Intent text is not in any event.** The poller reads intents through an
  allowlist (`INTENT_FIELDS`) without the words [V], so the poller must
  pass text to the ODS writer in-process, never into an event or research.

### 2.3 Per-sink consent routing [Decided: Carter, Q5]

Today the worker drops `digest.shared`, `digest.revoked` and `vote.cast`
for a tenant without research consent: none is on the ops allowlist
(addenda §4.1; DATA-99 open item (e)) [V]. A resident in the village but
not in research would share or vote and see nothing happen.

Ruling: consent is tracked per sink in the store, granularly, but the
onboarding consent covers every sink the village runs. There is one yes at
signup. Per-sink tracking is for audit and for later opt-outs; it is never
a second prompt. The ODS sink needs village consent in force
(`purpose = 'village'`, any scope) plus the item's grant; the research sink
keeps research consent. The writer takes the accepted event before the
research drop; the research copy is unchanged, and the gap shows in
research as coverage. Because scope cannot be widened after signup, the
signup sentence names every sink up front (§10 item 3), including group
and channel messages.

### 2.4 Writer rules common to every table

- Idempotent on the event id and the table key.
- Every granted act (`digest.share`, `village.vote`, `treasury.propose`,
  `resource.allocate`) resolves first (addenda §4.1 rules 3 to 9, by
  class). Unresolved is not written; retry until expiry or close (rule 6).
- Checks the door cannot make: a vote's `answer` is an option of an open
  question; a proposal's `budget_day` has an open or future ballot.
- Every write to a published table writes `ods.changes` in the same
  transaction (§5, §6).
- Group-message edits replace the stored text in place (current state, no
  edit history; `edited_at` is kept); a Telegram deletion tombstone deletes
  the row [Decided, Q14].
- First start replays unexpired `digest.shared` events (7 days at most)
  from the research event table under the same rules; shares the worker
  dropped before per-sink routing are lost (known limitation). No group
  messages are backfilled from the archive.

## 3. Published slices

Two reader classes on the feed (§4): **resident** (a person with an
accepted application for the Goa popup on EdgeOS, or a service acting for
one) and **public** (any other EdgeOS login, or a service credential with
no resident in the request). There is no anonymous class. Only roles inside
the Agent Village Railway project read base data (§4.3).

| Slice | Fields on the feed | Personal, never in the public class | Consent basis | Retention | Who reads |
|---|---|---|---|---|---|
| `questions` | `question_id`, `kind` (`weekly`, `treasury_ballot`), `text`, `options[{key,label}]`, `opens_at`, `closes_at`, `status` | nothing personal | village content | village end + 90 days | public, resident, Odin, Skylight |
| `tallies` | `question_id`, `tally_rule`, `counts{option: n}` (policy votes apart until Timour rules, DATA-99 AC #5), `turnout_n`, `eligible_n`, `final`, `computed_at` | who voted what; counts below the small-n floor | aggregate | village end + 90 days | public: final tallies only, suppressed below the floor; resident: also the running turnout (turnout only until close, Q7); Odin |
| `my_votes` | `question_id`, `answer`, `authorized_by` (`grant`, `policy`), `cast_at` | the whole slice; only the voter sees it | the vote's grant | village end + 90 days | the voter only |
| `proposals` | `proposal_id`, `text`, `amount_usd` (from `amount_cents`), `budget_day`, `status`, `ballot_question_id`, `proposer_ref` (resident class only), `agent_kind` | `proposer_ref` | the `treasury.propose` grant | village end + 90 days; a withdrawn proposal is deleted at once | public without proposer; resident with proposer [Decided, Q6; Timour to confirm]; Odin |
| `digests` | `digest_id`, `author_ref`, `display_name`, `scope` (`village` only on the feed), `text`, `shared_at`, `expires_at` | the whole slice | the `digest.share` grant | its `expires_at`, at most 7 days [V door cap] | resident; Odin (`village` and `service:coordination` scopes); the author sees their own of every scope |
| `intents` | `intent_ref`, `author_ref`, `display_name`, `text`, `updated_at`, an Index app link | the whole slice | §2.1 row [Decided, Q4: resident class, with text, never public, incognito excluded] | mirror: gone within one poll pass of archive, pause, incognito or withdrawal | resident; Odin |
| `resources` | `resource_id`, `kind`, `unit`, `supply`, `allocated`, `remaining` | nothing personal | village content | village end + 90 days | public, resident, Odin |
| `allocations` | treasury: `allocation_id`, `resource_id`, `proposal_id`, `amount`, `status`, `decided_at`, `executed_at`; top-up: daily count and sum per resource only | the beneficiary of any top-up; a treasury beneficiary in the public class | the principals' grant (Timour and Carter) | village end + 90 days; beneficiary nulled at withdrawal | public: aggregates; resident: treasury rows; the beneficiary: their own rows; Odin |

Group messages (`group_messages`, village end + 90 days at most, or
sooner on withdrawal, bot revoke or a deletion tombstone) are never on the
feed. Never on the feed, in any class: `group_messages` (Odin's view only), other
people's votes, tenant ids, Telegram ids or handles, EdgeOS emails or ids,
`decision_id`, `policy_version`, the local intention id behind an Index
intent, top-up beneficiaries.

Rules for every slice:

- **References, not ids.** A person appears as `author_ref` /
  `proposer_ref`: 16 hex of HMAC-SHA256 over the tenant id, computed by
  ingest under `ODS_REF_KEY` (name only), stable for the village, so a
  reader can join a person's digest to their proposal without the tenant id.
- **Display names** [Decided: Carter, Q9]. Display names MAY be stored:
  `ods.residents.display_name` is a cached copy from the EdgeOS attendee
  directory, written by ingest when it first needs it and refreshed on a
  schedule (hourly at most; the feed never calls EdgeOS for it). It is
  deleted with the `ods.residents` row at withdrawal. The digest approval
  card must say the share shows the resident's name (§10).
- **Small-n floor.** A public tally with turnout under 5 shows turnout only
  [NV the number; Timour].
- **Running counts** [Decided: Carter, Q7; Timour to confirm]. Residents see
  turnout, not counts, until close.

## 4. Auth model

### 4.1 People: EdgeOS login

- A person signs in with EdgeOS email OTP, as on the landing [V]. The feed
  takes the EdgeOS bearer, resolves it to an identity and the person's
  application status for the popup [NV: the EdgeOS route], and caches the
  answer under SHA-256 of the bearer for 10 minutes. The bearer is never
  stored, logged or forwarded.
- Accepted application: resident class (with or without an agent); any
  other identity: public class.
- Own rows (votes, digests of every scope, allocations) are found by
  `ods.residents.edgeos_ref`, a keyed hash of the EdgeOS identity computed
  by ingest and the feed (`ODS_EDGEOS_REF_KEY`); no email reaches the ODS.
- **Feed keys, week 2** [Decided: Carter, Q8]. An EdgeOS bearer given to a
  third-party agent is a full-power EdgeOS credential. Week 1 accepts the
  bearer (tier 1's zero lift); week 2 adds read-only feed keys minted by a
  control-plane route under EdgeOS auth, carried to the ODS as events
  (`feed_key.issued@1`, `feed_key.revoked@1`, hashed key only) so ingest
  stays the single writer. DATA-293 tells people to use one.

### 4.2 Services

- A service with no resident in the request gets the public class.
  Credentials are per function, hashed in the feed's environment
  (`ODS_FEED_SERVICE_KEYS`, name only), issued by Carter's hand.
- **A resident-class view needs a resident in the request.** A service that
  shows resident-class data (the app; Skylight if its viewers are residents)
  calls the feed with its viewer's EdgeOS bearer. No service credential
  reads the resident class on its own.
- Odin is the exception (base §7): a database role inside the project, its
  outputs through approval.md.

### 4.3 Database roles

| Role | Holder | Reads | Writes |
|---|---|---|---|
| `ods_writer` | ingest (`ODS_DATABASE_URL`) | everything | everything in `ods` |
| `ods_reader_coordination` | Odin | views `coord_*`: group messages, digests (`village`, `service:coordination`), questions, proposals, tallies, intents, resources, allocations; never individual votes | nothing |
| `ods_reader_feed_public` | feed service | views `feed_pub_*`, `changes`, `meta` | nothing |
| `ods_reader_feed_resident` | feed service | views `feed_pub_*`, `feed_res_*`, `changes`, `meta`, `residents.edgeos_ref` | nothing |
| `ods_reader_ops` | Carter's read-only wrapper | counts and non-text columns; no `text` column of any table | nothing |

Reader roles read views, never base tables. The feed connects under the
role matching the caller's class, so a route bug cannot put a resident
column in a public answer. No external agent gets a database credential.

## 5. Feed shape

Modelled on the paged read we asked of Index (`GET /api/events?after=<id>&limit=<n>`,
returning records, `next` and `more`) and Index's own cursor log
(`/api/events/log?after=&limit=`, 7-day retention) [V]. Routes, `GET` only:

- `/v1/me`: the caller's class and readable slices.
- `/v1/feed?after=<cursor>&limit=<n>&slices=<csv>`: changes after the
  cursor, in order. `since=<RFC 3339>` replaces `after` on a first request
  and starts at the first change at or after that instant.
- `/v1/slices/<slice>?page_after=<key>&limit=<n>`: current state, for a
  first load or a resync; each page carries the cursor it is consistent
  with (one `REPEATABLE READ` transaction).

### 5.1 Records

```
GET /v1/feed?after=c1.3f2a9b.48212&limit=200
{"items":[
  {"seq":48213,"slice":"questions","op":"upsert","key":"wq-2026-10-14",
   "at":"2026-10-14T09:31:07Z","schema":"questions@1","data":{...}},
  {"seq":48214,"slice":"digests","op":"delete","key":"7d1e...",
   "at":"2026-10-14T09:40:12Z"}],
 "next":"c1.3f2a9b.48214","more":false}
```

- `seq` increases in commit order: the change trigger takes one
  transaction-scoped advisory lock before `nextval` (§6), so no reader sees
  n+1 before n commits.
- One change entry per row: a row that changes again moves to a new seq,
  so the log never holds stale versions or content; `data` is read from
  the current row through the caller's views.
- Each entry keeps the `audience` its row last had (`public`, `resident`,
  `owner`). The feed silently skips entries the caller may not see, so a
  tombstone never reveals that a service-scoped digest or another person's
  vote existed.
- `schema` is `<slice>@<n>`. The cursor is opaque, `c1.<epoch>.<seq>`; a
  restore or rebuild changes the epoch, and an old cursor gets `410` with
  `{"resync":true}`.

### 5.2 Deletion and withdrawal: tombstones

Decision (this spec): **tombstones, no reason**. A deleted row (expiry,
revocation, withdrawal) appears as `op: delete` with only `slice`, `key`,
`seq` and `at`. Absence alone would make every reader diff snapshots, and
an agent that never diffs would keep a withdrawn person's text. No reason
is given, so a withdrawal looks like an expiry; withdrawal stays private.

- Items carry their own `expires_at`; a reader drops the row then, without
  waiting for the tombstone (physical deletes run hourly, §6).
- Tombstones are kept 7 days; a reader further behind gets `410` and
  resyncs from `/v1/slices`.
- Readers must apply a tombstone within one hour and keep nothing past its
  slice's retention. External agents are bound only by the feed terms
  (DATA-293); the feed cannot enforce them, which is why personal slices
  stay in the resident class.

### 5.3 Limits, caching, versions [NV the numbers; Seref]

- `limit` default 100, maximum 500. Per principal (identity, feed key or
  service credential) 60 requests a minute, burst 30, `429` with
  `Retry-After` and `RateLimit-*` headers; per IP 30 failed logins a
  minute. Agents should poll every 60 seconds or slower.
- `Cache-Control: private, max-age=15`; `ETag` on slice pages; no shared
  cache, since every page depends on the caller's class.
- Header `ODS-Feed-Version: 1`. A breaking change is `/v2`; a new slice or
  field is a new slice schema number, listed in `/v1/me`.

## 6. Schema

Its own Railway Postgres instance (base §3) [V decision], schema `ods`,
migrations in `agentvillage-data` under `migrations/ods/` from `0001`,
apart from the research sequence. DDL sketch:

```sql
CREATE SCHEMA ods;
CREATE TABLE ods.meta (epoch text NOT NULL);      -- one row; a new value on restore or rebuild
CREATE SEQUENCE ods.change_seq;

-- A row exists exactly while the tenant's village consent is in force. Written by
-- ingest from tenant.* and consent.* events and the identity map.
CREATE TABLE ods.residents (
  tenant_id text PRIMARY KEY,
  resident_ref text NOT NULL UNIQUE,              -- HMAC(ODS_REF_KEY, tenant_id), 16 hex
  edgeos_ref text UNIQUE,                         -- HMAC of the EdgeOS identity, never the email
  group_consent boolean NOT NULL DEFAULT false,   -- DATA-214 sentence in force
  display_name text,                              -- cached from the EdgeOS directory (Q9)
  display_name_refreshed_at timestamptz,
  updated_at timestamptz NOT NULL);

CREATE TABLE ods.group_messages (                 -- base §4; chat_hash per DATA-216
  chat_hash text NOT NULL, message_id bigint NOT NULL,
  sender_tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  sent_at timestamptz NOT NULL, text text NOT NULL, reply_to_message_id bigint,
  edited_at timestamptz,                          -- text replaced on edit; row deleted on a deletion tombstone (Q14)
  expires_at timestamptz NOT NULL,                -- village end + 90 days (Q2)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_hash, message_id));
CREATE INDEX ON ods.group_messages (chat_hash, sent_at);

CREATE TABLE ods.digests (                        -- base §5; keyed per addenda rule 8
  tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  digest_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^(village|service:[a-z][a-z0-9_-]{0,63})$'),
  text text NOT NULL, shared_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  decision_id uuid NOT NULL,                      -- the resolved decision, never the claim
  policy_version text,
  PRIMARY KEY (tenant_id, digest_id),
  UNIQUE (tenant_id, scope));                     -- one live row per (resident, scope)
CREATE TABLE ods.digest_revocations (             -- addenda rule 10
  tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  digest_id uuid NOT NULL, remember_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, digest_id));

CREATE TABLE ods.questions (
  question_id text PRIMARY KEY CHECK (question_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  kind text NOT NULL CHECK (kind IN ('weekly', 'treasury_ballot')),
  text text NOT NULL,
  options jsonb NOT NULL,                         -- [{key, label}]; keys per vote.cast.answer
  opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
  tally_rule text NOT NULL, source_event_id text NOT NULL);

CREATE TABLE ods.votes (                          -- DATA-99 AC #4
  question_id text NOT NULL REFERENCES ods.questions,
  tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  answer text NOT NULL,
  authorized_by text NOT NULL CHECK (authorized_by IN ('grant', 'policy')),
  decision_id uuid,                               -- null exactly when policy
  policy_version text, cast_at timestamptz NOT NULL, event_id text NOT NULL,
  PRIMARY KEY (question_id, tenant_id));

CREATE TABLE ods.tallies (
  question_id text PRIMARY KEY REFERENCES ods.questions,
  tally_rule text NOT NULL,
  counts jsonb NOT NULL,                          -- {option: {grant: n, policy: n}}
  turnout_n integer NOT NULL, eligible_n integer NOT NULL,
  final boolean NOT NULL, computed_at timestamptz NOT NULL);

CREATE TABLE ods.proposals (                      -- rules in DATA-292
  proposal_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  text text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  budget_day date NOT NULL, ballot_question_id text REFERENCES ods.questions,
  status text NOT NULL CHECK (status IN ('open', 'withdrawn', 'funded', 'not_funded', 'expired')),
  decision_id uuid NOT NULL,
  agent_kind text NOT NULL DEFAULT 'hosted' CHECK (agent_kind IN ('hosted', 'external')),
  proposed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);

CREATE TABLE ods.intents_public (
  index_intent_id text PRIMARY KEY,
  intent_ref text NOT NULL UNIQUE,                -- HMAC; what the feed shows
  tenant_id text NOT NULL REFERENCES ods.residents ON DELETE CASCADE,
  text text NOT NULL, updated_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL);                  -- last poll that saw it active, not incognito

CREATE TABLE ods.resources (                      -- base §6
  id uuid PRIMARY KEY, kind text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('usd', 'hours', 'slots')),
  supply numeric NOT NULL CHECK (supply >= 0), popup_id text NOT NULL,
  created_at timestamptz NOT NULL);
CREATE TABLE ods.allocations (                    -- base §6, plus proposal_id
  id uuid PRIMARY KEY, resource_id uuid NOT NULL REFERENCES ods.resources,
  tenant_id text REFERENCES ods.residents ON DELETE SET NULL,
  proposal_id uuid REFERENCES ods.proposals ON DELETE SET NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  decision_id uuid, policy_version text, execution_token_id text,
  requested_at timestamptz NOT NULL, decided_at timestamptz, executed_at timestamptz,
  status text NOT NULL CHECK (status IN
    ('requested', 'allocated', 'executed', 'declined', 'expired', 'stale')));

-- The feed's change log: one entry per published row, never content.
CREATE TABLE ods.changes (
  seq bigint PRIMARY KEY, slice text NOT NULL, row_key text NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert', 'delete')), changed_at timestamptz NOT NULL,
  audience text NOT NULL CHECK (audience IN ('public', 'resident', 'owner')),
  owner_tenant_id text,                           -- set exactly when audience = 'owner'
  UNIQUE (slice, row_key));
-- An AFTER INSERT/UPDATE/DELETE trigger on each published table takes
-- pg_advisory_xact_lock(<ods change lock>), deletes the row's old entry and
-- inserts one at nextval('ods.change_seq').
```

Views, owned by `ods_writer`: `feed_pub_*` (questions, final tallies above
the floor, proposals without proposer, resources, allocation aggregates),
`feed_res_*` (adds `village` digests, intents, proposer refs, treasury
allocations, turnout, own rows), `coord_*` (Odin). Each filters
`expires_at > now()`, so expiry is immediate in reads. Own-row views filter
on a per-request session setting; row-level security is the build's
choice [NV].

**Retention jobs** (ingest): hourly, rows past `expires_at` (group
messages and every slice with a village-end bound are set to village end +
90 days, Q2; digests keep their own `expires_at`, at most 7 days, and
intents their mirror rule); nightly, tombstones over 7 days, revocation
memory past `remember_until`, and the display-name refresh. Logs carry
counts, never ids or text. The instance is dropped at village end + 90
days [Decided: Carter, Q2; Timour to confirm]. The retention bound is "up
to 90 days after the village": earlier deletion on withdrawal, revocation,
a deletion tombstone or `expires_at` always wins.

**Withdrawal delete path.** One ingest job deletes from both sinks (base §3):

- `consent.withdrawn` (village purpose) or `tenant.deleted`: in the pass
  that receives it, delete the `ods.residents` row; foreign keys cascade to
  every personal row and null allocation beneficiaries. No grace window
  (DATA-130's grace is research's; nothing here is a record). A re-grant
  restores nothing.
- Bot revoke (DATA-216 AC #3): delete the sender's group messages and
  clear `group_consent`.
- `digest.revoked`, `treasury.withdrawn`: delete the row, keyed on tenant
  and id (addenda rule 8). Index archive, pause or incognito: the next poll
  deletes the intent.
- A test asserts every table with `tenant_id` has a cascading or nulling
  key to `ods.residents`, so a new table cannot forget withdrawal.

## 7. Events and producer classes to reserve now

Closed payloads, registered in `src/schemas/index.ts` with
`PRODUCER_ALLOWLIST` rows before Oct 11, so emitters built after launch
need no contract change. Registration is data-side: no roll, nothing a
resident sees.

| Type | Producer | Class cap | Fields | Notes |
|---|---|---|---|---|
| `village.question_opened@1` | `operator`, `odin` | `operator_verified` / `agent_report` | `question_id`, `kind`, `text` (≤ 500, `DIGEST_TEXT_PATTERN`), `options` (2 to 12 `{key, label}`, labels ≤ 80 under the same rule), `opens_at`, `closes_at`, `tally_rule` | Timour owns content (DATA-99) |
| `village.question_closed@1` | `operator`, `odin` | as above | `question_id`, `status` (`closed`, `cancelled`), `closed_at` | early close or cancel |
| `treasury.proposed@1` | `plugin` only (`PLUGIN_ONLY`) | `agent_report` | `proposal_id` (lower-case UUID), `text` (digest text rule), `amount_cents` (integer), `budget_day` (date), the four approval-link keys (`grant` only), optional `decision_id`, `policy_version` | key `treasury.propose:<proposal_id>`; payload hash over exactly `{proposal_id, text, amount_cents, budget_day}` |
| `treasury.withdrawn@1` | `plugin` only | `agent_report` | `proposal_id`, optional `decision_id` | no grant, like `digest.revoked` |
| `resource.supplied@1` | `operator` | `operator_verified` | `resource_id`, `kind`, `unit`, `supply`, `reason` | base §6 |
| `resource.requested@1` | `odin`, `plugin` | `agent_report` | `request_id`, `resource_id`, `amount`, `decision_id` | base §6; `moralmod` never; the `plugin` entry stays reserved but unused on resident seats in October (Q12) |
| `resource.allocated@1` | `odin`, `operator` | `agent_report` / `operator_verified` | `allocation_id`, `resource_id`, `amount`, `proposal_id` nullable, `recommendation_event_id` nullable, approval-link keys for `odin` | base §6 plus `proposal_id` and the link |
| `resource.executed@1` | `control_plane` | `platform_record` | `allocation_id`, `resource_id`, `amount`, `execution_token_id`, `receipt` | one outbox transaction with `key.topped_up` |
| `key.topped_up@2` | `control_plane` | `platform_record` | `@1`'s three plus optional `decision_id`, `execution_token_id`, `policy_version` | `@1` is closed [V], so base §6's additions are a `@2` |
| `tally.closed@1` | `odin`, `operator` | `agent_report` / `operator_verified` | `question_id`, `tally_rule`, `counts`, `turnout_n`, `eligible_n`, `closed_at` | see below |

**Producer class `odin`.** One entry in `TOKEN_CLASSES`, one
research-instance migration widening the two CHECKs (next free number;
`0040` is the last today [V]), a `PRODUCER_ALLOWLIST` row with the types
above, and a `capFor` line returning `agent_report`. Odin's proposals reach
`platform_record` only through the follower reading its own approval.md
seat (DATA-255: a Railway service on the resident pattern). Principals for
allocations are Timour and Carter, no automatic approvals: a policy never
pre-authorises an allocation, including small ones [Decided, Q3; Timour
to confirm]. The earlier single-principal ruling (B5b) is superseded.

**One tally event.** The ODS counts voters with village consent; research
sees only research-consenting ones, so dbt cannot recompute the official
result. `tally.closed@1` records at close the counts allocated against, no
voter. Before Odin's seat exists an operator script closes tallies and emits it
[Decided: Carter, Q13].

**Ballots reuse `vote.cast@1`.** A treasury ballot is a question of kind
`treasury_ballot` whose option keys are proposal ids (a UUID fits the
answer pattern [V]) or `yes`/`no` per proposal, as DATA-292 picks; neither
changes `vote.cast@1`.

**Approval classes** (policy template and settings page, not events):
`digest.share` and `village.vote` exist [V `APPROVAL_REVIEW_SWITCH_VALUES`];
`treasury.propose` must join them before Oct 11 (DATA-292). There is no
`resource.request` class on resident seats in October: a treasury proposal
covers it [Decided: Carter, Q12]; the class would be a policy amendment
later. Odin's classes
(`resource.allocate`, `resource.topup`) live on its own policy and land
with its seat.

**Not reserved:** `service.read` (base §9, unchanged); tier-3 types and
`feed_key.*`, which the control plane emits with no tenant roll, so they
register later (the ODS takes `agent_kind` from the producer class).

## 8. Readers

**Odin** (`ods_reader_coordination`, base §7). Group messages, digests in
scopes `village` and `service:coordination`, questions, proposals,
tallies, intents, resources, allocations. Not individual votes: it
allocates against tallies, never against who voted what. Never resident
memory, the archive or `text.messages`; it never writes the store.

**Skylight** (`Edge-City/skylight`, Timour's 3D world). One shared world
every viewer sees, so by §4.2 it reads the public class with a `world`
service credential: question, final tallies, proposals without proposers,
resource totals. If every viewer is a verified resident it may read the
resident class on a viewer's bearer [Decided, Q11: public unless every
viewer is a verified resident; Timour to confirm]. ODS text
it passes to a model goes only to a processor that does not train on it.

**External agents, BYOA tier 1** (DATA-290, DATA-293). The feed routes only,
under their human's EdgeOS login (week 1) or a feed key (week 2); they see
what their human sees, are never in the research cohort, and their reads
are not events. Hosted agents may read the same feed through a skill (not
in this spec).

**The Edge City app** (`/insights` [NV the page]). Calls the feed with the
signed-in person's bearer, no credential of its own: the question and
result, open proposals, resource totals, and a resident's own votes and
digests with a revoke that files `digest.revoked` through their agent [NV
path]. The app owner builds the page.

## 9. Operations

- **Instance.** Its own Railway Postgres service, Carter's hand (base §3)
  [V decision]. `ODS_DATABASE_URL` (`ods_writer`) on ingest only; the feed
  gets its two reader URLs, Odin its own. Names only here.
- **Feed placement** [Decided: Carter, Q10]. A separate small `ods-feed`
  service built from `agentvillage-data`, holding only reader credentials,
  so the internet-facing route never sits beside the writer's credential.
  No routes on ingest.
- **Backups.** Railway volume backups, shortest retention; no logical dump
  leaves the instance. A restore sets a new epoch and, before the feed
  reopens, replays every withdrawal, revocation and deletion since the
  backup from the research instance, so no withdrawn row comes back.
- **Monitoring and operator reads.** Writer lag, items awaiting the
  follower, retention counts, 4xx and 429 rates per class; counts only.
  Operators read through a wrapper under `ods_reader_ops`, no text columns.
- **Acceptance scenario** (dogfood tenants; nothing is called live until
  every step passes):
  1. A consenting resident's group message reaches `coord_group_messages`
     within one batch and no feed route; a non-consenting sender's never.
  2. A granted village digest is on the resident class, not the public
     class; a declined or unresolved one never appears; a revocation yields
     a tombstone within one batch; a resend after it is not written.
  3. A granted and a policy vote are stored apart, a declined one is absent;
     after close the public class shows the final tally above the floor and
     `tally.closed` reaches the research instance.
  4. Village-consent withdrawal deletes every row of the tenant in one pass;
     the feed shows tombstones only; a re-grant restores nothing.
  5. A non-resident login sees questions, final tallies, proposals without
     proposer and resource totals, and `403` on resident slices; no login
     gets `401`.
  6. `ods_reader_feed_public` cannot select a `feed_res_*` view or a base
     table; `ods_reader_coordination` cannot select `votes`.
  7. A reader resumes from its cursor with no gap or duplicate across a
     writer restart; an older epoch's cursor gets `410`.
  8. Rows past `expires_at` are invisible at once and deleted within the hour.

## 10. Sequence

This replaces base §8's timing: the wave-2 plan moves the ODS build after
launch and keeps only reservations before it.

**Before Oct 11: reserve, no build.**

1. Register §7's event types, allowlist rows and the `odin` class.
2. Add `treasury.propose` to the
   policy template and settings page, manual by default (DATA-292).
3. Consent wording [Carter rules the shape (Q5); Timour approves the
   words]: one yes at signup covering every sink the village runs, so no
   second prompt follows. It says that messages a resident posts in the
   village Telegram groups and channels, and the digests, votes and
   proposals a resident approves, are shown to village services (Odin,
   Skylight, the app) and to other residents and the agents they use, kept
   for up to 90 days after the village ends, and deleted on withdrawal.
   Changing wording after launch means re-consent.
4. The digest approval card names the audience and that the share shows
   the resident's name (overlay, the Oct 11 tag).
5. Per-sink routing is decided (§2.3, Q5); its build is week 1.

**Week 1 (Oct 12 to 17), backend only:** the service (Carter's hand),
`migrations/ods/0001`, writer, retention, withdrawal, the group-message
sink if DATA-216 is live, the announcements listener, acceptance, Odin's
read role. Feed routes follow Seref's Q1 ruling (second half below).
**Week 2 (from Oct 18), treasury live:** proposals, ballots, tallies,
allocations, Odin's seat (DATA-255), overlay propose and vote tools,
Skylight's view, feed keys. Tier 3 only after Timour's yes (DATA-290).

**Build tasks to file.** Numbers are stable ids for this spec.

First half: no open question depends on it. Build may start before launch
if Carter pulls it forward.

| # | Title | One line | Owner repo |
|---|---|---|---|
| 1 | ODS Railway service and credentials | The store's own Postgres instance, role URLs, `ODS_DATABASE_URL` on ingest; Carter's hand | `agentvillage-data` (tracking) |
| 6 | ODS schema, roles and views | `migrations/ods/0001` (`ods.*` DDL), the roles of §4.3, the cascade test, the role-grant test | `agentvillage-data` |
| 7 | ODS ingest write path | `digest.shared`, `digest.revoked` and `vote.cast`: resolution rules, change trigger, first-start digest replay, membership checks | `agentvillage-data` |
| 5 | Per-sink consent routing | ODS sink on village consent plus grant, per-sink tracking for audit; research sink unchanged (Q5) | `agentvillage-data` |
| 19 | Announcements listener | Reads the village announcements channel into the ODS; feeds the knowledge snapshot | `agentvillage-data` |
| 21 | Display-name cache | `ods.residents.display_name` refreshed from the EdgeOS directory (Q9) | `agentvillage-data` |
| 8 | ODS retention and withdrawal deletes | Hourly and nightly jobs (village end + 90 days), the withdrawal pass, the restore replay runbook | `agentvillage-data` |

Reservations before Oct 11 (no build): 2 to 4 below.

| # | Title | One line | Owner repo |
|---|---|---|---|
| 2 | Reserve ODS and treasury event types and the `odin` class | §7 schemas, allowlist rows, token-class migration, tests; before Oct 11 | `agentvillage-data` |
| 3 | Reserve `treasury.propose` in the policy template and settings page | One switch, manual default; no `resource.request` (Q12); before Oct 11 | approval.md template, `controlplane`, the Edge City app |
| 4 | ODS consent sentence | Item 3 above in the brief; Timour approves the words; before Oct 11 | landing |

Second half: after Seref's Q1 ruling on feed scope.

| # | Title | One line | Owner repo |
|---|---|---|---|
| 11 | ODS feed service | Separate `ods-feed` service (Q10): §5 routes, limits, slices per Q1 | `agentvillage-data` (new entrypoint) |
| 20 | Auth tiers | EdgeOS bearer resolution into public and resident classes, service credentials, per-class reader roles (§4) | `agentvillage-data` |
| 14 | Feed keys | Mint and revoke route under EdgeOS auth, `feed_key.*` events; week 2 (Q8) | `controlplane`, `agentvillage-data` |
| 12 | ODS acceptance on dogfood | §9 scenario, evidence in the task | `agentvillage-data` |

Later, no open question blocks them but they follow the above:

| # | Title | One line | Owner repo |
|---|---|---|---|
| 9 | Group-message second sink | Archive-write text to `ods.group_messages`; edits replace, tombstones delete (Q14); bot revoke; on DATA-216 | `agentvillage-data` |
| 10 | Public intents sink | Poller passes active, non-incognito `agentvillage` intents in-process (Q4); after the poller's enable | `agentvillage-data` |
| 13 | Odin's read role and first query set | `coord_*` views and Odin's reads | `agentvillage-data` |
| 15 | Atomic top-up and `key.topped_up@2` | Base §6's control-plane piece with `resource.executed`; Seref reviews | `controlplane` |
| 16 | Skylight ODS reader | Public-class view of question, tallies, proposals, resources | `Edge-City/skylight` (Timour) |
| 17 | App `/insights` on the feed | Viewer-bearer reads, own votes and digests | the Edge City app (its owner) |
| 18 | BYOA tier-1 feed documentation | Routes, classes, deletion terms, feed keys over bearers | `agentvillage` (DATA-293) |
| 22 | Tally close script | Operator script that closes tallies and emits `tally.closed@1` (Q13) | `agentvillage-data` |

## 11. Decided 2026-10-05/06

Closed and not reopened: instance placement (Carter, base §3). Carter ruled
on Q2 to Q14 on 2026-10-05 23:57Z and 2026-10-06 00:02Z (CLAIMS).

| # | Question | Ruling | Status |
|---|---|---|---|
| Q2 | Retention: group messages, votes after close, the instance | Up to 90 days after the village, for group messages, votes after close and the instance alike. Digests keep their own `expires_at` (at most 7 days) and intents their mirror rule; earlier deletion on withdrawal always wins | Ruled by Carter, Timour to confirm |
| Q3 | Principal for allocations; pre-authorisation | Timour and Carter are the principals; no automatic approvals | Ruled by Carter, Timour to confirm |
| Q4 | `intents` slice | Yes: the village tool's intents are visible to village readers (resident class) with text, never public; incognito excluded | Decided |
| Q5 | Per-sink consent routing | Consent tracked per sink in the store; the onboarding consent covers every sink the village runs; one yes at signup; per-sink tracking is for audit and later opt-outs, never a second prompt | Decided |
| Q6 | Proposer named to residents | Yes to residents, never public | Ruled by Carter, Timour to confirm |
| Q7 | Running counts during a vote | Turnout only until close | Ruled by Carter, Timour to confirm |
| Q8 | Feed keys versus bearers | EdgeOS bearer in week 1, feed keys in week 2 | Decided |
| Q9 | Display-name source | Display names may be stored: a cached copy from the EdgeOS directory, refreshed | Decided |
| Q10 | Feed placement | Separate feed service with reader credentials only | Decided |
| Q11 | Skylight's class | Public unless every viewer is a verified resident | Ruled by Carter, Timour to confirm |
| Q12 | `resource.request` on resident seats | None in October | Decided |
| Q13 | Who emits `tally.closed` before Odin's seat | An operator script closes tallies | Decided |
| Q14 | Edits to group messages | Replace the text on edit; delete on a deletion tombstone | Decided |

**Still open:**

- Q1 (Seref): which slices are on the feed, and what a non-resident sees.
  Recommendation: §3 as written; the public class gets questions, final
  tallies above the floor, proposals without proposer and resource totals;
  group messages never. It gates the feed service, auth tiers and feed
  keys (§10, second half), not the first half.
- Timour's confirmation of Q2, Q3, Q6, Q7 and Q11.
- Not questions but numbers still [NV]: the small-n floor (Timour), the
  rate limits (Seref), and the consent wording (Timour approves).

## 12. Supersession record

- 2026-10-04, v1 (this spec), from base v3. Changes: weekly-question types
  instead of `question.*`; digest and vote evidence is `agent_report`;
  per-sink consent (proposed); withdrawal covers votes, proposals and
  intents and nulls beneficiaries; `key.topped_up@2`; base §8's timing
  replaced by the wave-2 reservation rule.
- 2026-10-06, v2: Carter's rulings Q2 to Q14 applied (§11). Retention is up
  to 90 days after the village (was 14 days, 7 days and village end + 30
  days); allocations have two principals, Timour and Carter; display names
  are stored as a cached copy; the feed is a separate service; no
  `resource.request` class in October; an operator script closes tallies;
  group-message edits replace, tombstones delete; consent is tracked per
  sink under one signup yes; build tasks split into a first half and a
  second half after Seref's Q1.
