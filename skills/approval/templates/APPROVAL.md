# Approval Policy (Agent Village resident, day-one template)

<!--
The installer does NOT write this file into the sandbox's Hermes home. The
control plane does, into the co-located daemon's store.

Where it lives. Each resident sandbox runs its own approval.md daemon as the
`approvald` uid (10001), with its store at /var/lib/approvald/<tenant>/data
(0700, approvald-only). The hermes uid never reads or writes this file. At
provisioning the control plane's root step renders this template with the
tenant's paired ids, writes it into that store as approvald, and runs
`approval policy attest --as human:<operator>` (DATA-250, APRV-449). That is
an operator attestation, stated as such in the consent copy: the village
operator set the starting policy, and no `approval.granted` is ever written by
that path. A re-run is idempotent (`policy-already-attested` is the expected
refusal). The resident re-attests in the Edge City app's onboarding review
(DATA-259); until the `edgeos` sender channel lands in core (APRV-455) that
review is recorded on the Agent Village side only. Every later change needs
the resident's acceptance in the app or their tap on Telegram.

Placeholder, filled at render time:

  <telegram_user_id>  the resident's numeric Telegram account id from the
                      pairing (callback_query.from.id, digits only). An
                      unrendered template fails the core schema, and a policy
                      the loader rejects resolves every class manual: it fails
                      closed, never open.

The approver id is the literal `resident`; the tenant is already the store.

Shape: the recorder (Carter's ruling, 2026-10-03). Day one records every
hooked tool call and blocks none of them. The earlier hosted-shape template
made network.call, read.web, message.send and the routed Hermes tool classes
manual with a 4m TTL; under `fail_closed` and APPROVALD_ENFORCE=1 that would
have held every curl and every routed tool in a resident's terminal behind a
tap, with nobody yet told to expect one.

What waits for a tap. Only classes an agent opens with `approval propose`
(approval.md 0.4.0, PR #569), never a hooked tool call:

  - intent.publish.inferred.index: an intention the overlay inferred, before it
    is published to Index (DATA-212 Lane B). intent.publish.* makes a future
    intent.publish.<other> class proposable without a policy edit.
  - digest.share: a digest the agent drafted, before it is shared (DATA-96
    section 5), if digests ship.
  - village.vote: the agent's draft answer to the weekly village question, or
    its draft vote on the village's daily treasury ballot, before it is cast
    (DATA-99, DATA-292).
  - treasury.propose: a treasury proposal the agent drafted for the resident,
    before it is filed (DATA-292; reserved, live from Oct 18).
  - treasury.withdraw: withdrawing a treasury proposal the resident made, on
    the agent's suggestion, before it is withdrawn (DATA-292).
  - edgeos.event.write, edgeos.venue.write: creating or changing an event or a
    venue in EdgeOS through the agent, beyond an RSVP (DATA-322). No tool uses
    either before Oct 18.
  - marketplace.app.install: installing an agentic app or an MCP server from
    the village marketplace, before it is installed (R2; `marketplace.*` is a
    reserved namespace).
  - marketplace.app.action: an installed app acting for the agent, before it
    acts; the request payload names the app and the verb (R2).
  - resource.allocate: the treasury/ODS allocation class, an allocation of
    village resources proposed for the resident, before the agent takes it up
    (R2 addendum). `odin.*` is a reserved namespace for the allocator's own
    classes (DATA-255): a comment line in the block, no row.
  - moralmod.assess: the agent asking the MoralMod research advisor to assess
    a decision it is weighing for the resident, before it sends the advisor
    the situation and the choices (ODS-RESERVE, cp#147; reserved, wired to
    the bridge in week 1 after Oct 11). Nothing proposes it yet; the settings
    page offers ask and never in October (the lead's ruling, Oct 8 20:06Z);
    "on its own" arrives with the bridge wiring PR, which changes no policy
    bytes.

opportunity.accept (R3) waits for no tap on day one: accepting or declining an
Index opportunity, a connection or meeting, on the resident's behalf is
autonomous, with `agent_may_request`, and the settings page offers ask and
never. It is its own class, not network.call, because it commits the resident
to something; autonomous is its day-one default (Carter's ruling, Oct 7: the
accept happens in a conversation with the agent that fires the Index call, so
a second gate would ask twice). Nothing proposes it: the `tools:` list maps
Index's accept_opportunity and reject_opportunity (MCP) and the Index Hermes
plugin's index_update_opportunity (its accept or decline) to it, so only the
approval gate judges it. It is
recorded, and the resident's choice applies, only while the gate is on; the
settings page says so (`enforced_by: hook`).

The treasury, EdgeOS, marketplace and allocation rows are reserved now and
built later: no tool proposes them yet, and writing them before Oct 11 means
week two's experiments need no policy amendment (a change to every tenant's policy
bytes, and so a re-attestation, after enforcement starts). Two more R2 rows
are reserved the same way and wait for no tap: marketplace.app.read
(autonomous and recorded: an installed app reads for the agent) and
review.delegate.model (manual with no `agent_may_request`, so no agent can
propose it and no hook maps it: kept for the resident to choose later to let
a model reviewer act first; nothing acts on it today). The `delegation:`
block of the judge design is not in this policy: core before 0.4.2 refuses an
unknown top-level key, which would fail every class closed.

A resident may change these in the onboarding review (DATA-259); the rows below
are the defaults.

intent.publish.stated.index is autonomous: an intention the resident stated in
their own words is published without a second ask, and still recorded.
`agent_may_request: true` is what opens `propose` to a class; it exists in the
core schema from approval.md 0.4.0 (PR #569). `tools:` and
`defaults.unmapped_tool` exist from 0.4.2 (APRV-499), so this policy needs a
daemon at 0.4.2 or later. On an older daemon the schema rejects the keys and
the policy resolves every class manual (fail closed).

TTL. `approval_ttl: 72h` is global because core has no per-class TTL. It is the
window a proposal has: the plugin polls and executes on its own, so no request
is held open inside a tool call. A hook-opened request (any class made manual
later) still clamps to the harness cap minus 60 s: the daemon serves with
`--hook-harness-cap 300s`, so 240 s, whatever the TTL says.

The Hermes tool rows (cron.manage, process.write, browser.exec, skill.manage,
agent.delegate, message.send) take the classes core's Hermes adapter emits from
PR #569 (cronjob_manage, process_manage writes, browser_*, skill_manage,
delegate_task, send_message). They are written out autonomous, with network.call
and read.web, so the file says what day one does: these calls are recorded, not
gated. A class a resident later makes manual waits at most 240 s inside the tool
call (above). A cron job's script still runs at every tick with no hook at all,
so creating or changing the job is the only point a tap could ever come.

Tool names (`tools:`, approval.md 0.4.2, APRV-499). The list names the class a
hooked tool call is judged under when core's Hermes adapter does not class it
itself: the shell, file and read tools and the rule table keep precedence, so
the lines for the rule-table tools are inert and repeat the class the table
gives. Web reads and Index's read tools are read.web; a new or reworded
intention in the resident's words through Index is intent.publish.stated.index
(so the resident's "Intents you state" row governs a direct create_intent
while the gate is on); accepting or declining an opportunity (Index's
accept_opportunity and reject_opportunity, the plugin's
index_update_opportunity) is opportunity.accept; every other Index tool, and
the tools that send content to a model provider, are network.call.
record_intention is left off the list and unrouted: it publishes a stated
intention itself and holds an inferred one for the tap, and an ask on
intent.publish must never block capture. Every class is a row above, so
the settings page needs no row of its own for a tool. `defaults.unmapped_tool:
record` records any other hooked tool under harness.tool.unmapped (autonomous,
the tool named in the start's `harness_tool`); `ask` would hold each for a tap
and is a per-tenant choice for later, not the template's. No class limit on
harness.tool.unmapped (ruled 2026-10-06 01:37Z). Only the installer's gated
tools (APPROVAL_GATED_TOOLS) reach the hook, and only while the gate is on.
R3b, which merges with this policy, routes every Index write (the nine of its
MCP surface and the plugin's eight write tools), media generation, web_search
and x_search; Index's read tools and the local tools stay unrouted (av-events
records every call as tool.call either way). Removing both keys restores the
0.4.1 behaviour on a 0.4.2 daemon (an unnamed tool passes unrecorded).

The three organ rows are mandatory under an autonomous default. Core classifies
the Hermes home's config.yaml, agent-hooks/, hooks* and the consent allowlist as
policy.core, and .env and auth.json as account.credential (APRV-415). Without
these rows an autonomous default would let the agent edit its own gate or read
the resident's credentials. log.mutate keeps the daemon's log out of reach for
the same reason. Core refuses `agent_may_request` on a human-only class at
load, so these rows carry none.

Two more reserved rows are human-only on day one (ODS-RESERVE, cp#147).
moralmod.share_context: the resident's context is never included in a group
assessment other residents see in aggregate unless the resident chooses, in
the app's settings, to be asked first (the page offers never and ask; ask
renders the row manual with `agent_may_request`). coordinator.contact: no
village coordinator agent sends a resident a suggestion in October; the row
is locked there (the settings page shows it and sets nothing) and becomes
the resident's choice later.

Read scope on a co-located daemon. The daemon host IS the sandbox now, so the
paths in the hook envelope (/home/hermes/.hermes/...) are real paths on the
daemon's own filesystem. They still sit outside every read root: the gate root
is the directory holding this file (the approvald store), plus the scratch and
temp roots, and the hermes home is none of those. A file read the classifier
judges by path therefore comes back `read.file.out_of_scope`, and the approvald
uid may not be able to resolve a path inside the hermes-owned home at all. This
template leaves read.file.out_of_scope to defaults.autonomy (autonomous), so
reads run and are recorded under that distinct class. A resident who wants
reads inside their own home recorded as in-scope can add `read_scope.roots:
[/home/hermes/.hermes]` by amendment; day one does not, so the record keeps
reads outside the gate root visibly separate.

The channel. `token_env: APPROVAL_RELAY_TOKEN` is the control-plane relay
credential in approvald's 0600 env; the daemon's Telegram channel runs under
`approval up --api-base $APPROVAL_RELAY_API_BASE`, pointed at the relay, so the
prompt reaches the resident through the "Agent Approval (Edge City)" bot (its
BotFather display name since Oct 9, 2026, formerly "Agent Village Approvals";
the username and token are unchanged).
`chat_id_env: APPROVAL_RESIDENT_CHAT` names a variable the control plane must
write into that env (one line in ensureApprovald): core refuses a tap whose chat
differs from the configured one (`foreign-chat`), so the daemon must know it.
`token_delivery: sealed` is inert for proposals (they mint no token) and matters
only if a later manual class is executed through `approval run`.

`delivery: burst` (core 0.4.0, `channels.telegram.delivery` in
schema/policy.schema.json, APRV-216). Without it delivery is `paced`: the
listener sends the oldest pending request and the next one only once that one
is decided, skipped or passed over, and `/skip` and `/next` are bot commands.
The relay forwards no text command but `/start` (and ForceReply answers), so a
resident cannot skip, and one proposal left unanswered for its 72 h window
would hold back every later card. `burst` sends each request the listener has
not yet sent, once; nothing about what is pending, or what a tap decides,
changes. A review walkthrough (supervised-retro) stays paced in both modes.

The card (`prompt.style: minimal`, approval.md 0.4.1+, APRV-489, DATA-370). A
resident gets core's minimal card: ONE message, "Your agent wants to <phrase>",
the request's own words quoted in a box under short labels, "Open for about 3
days", Approve/Deny, and the whole technical card (computed rows, canonical
rendering, sha256, the agent's claimed summary) folded under "Full details".
Carter's ruling (2026-10-07): minimal is the default for every resident; the
style line is written alone on its line because the app's Approvals setting
(lane CARD-SETTING, in the control plane's approval-settings.js) is to rewrite
exactly that line to `technical` for a resident who wants the engineer's card.

The `say:` block is the operator's wording, attested with the rest of this file
(Carter attests the words). Per EXACT class: `does` finishes "Your agent wants
to ..." (a verb phrase, no sentence punctuation, at most 120 characters); core
words the eight Hermes tool classes and the shell itself, so those entries set
no `does`. `quote` names every top-level key the request's payload can carry:
a label (letters, digits, spaces, at most 24) shows that value verbatim, `~`
keeps it off the card (core then prints "Not shown here: <key>" under the box),
and `""` shows a lone value with no label. A payload with a key the map does
not name, a class with no entry, a request over 3800 characters (a long
intention's Full details), or any abnormal fact gets the technical card, and
the decision record says why (`payload.rendering.fallback`: `unlisted-key`,
`undeclared`, `too-long`, `anomaly`, ...). The agent's one-line summary shows
under the box marked "not checked" (`note: summary`, the default); `note:
none` leaves it to Full details. A vote's summary leads with the chosen
option's label, then the question (_share_vote.py summary_for), because the
card cuts a claimed line at 280 characters. The payloads quoted: an intention
`{text}` (av-events _intent_approval.py), a share `{digest_id, scope, text,
expires_at}` and a vote `{question_id, answer}` (_share_vote.py), and a Hermes
tool call the hook gates `{tool, input}` (core's hook, APRV-445/499). ids are
`~`. The reserved classes no tool proposes yet (treasury.*, edgeos.*.write,
marketplace.app.*, resource.allocate, review.delegate.model, moralmod.*,
coordinator.contact) have no entry:
their payload keys do not exist yet, so they stay technical (`undeclared`)
until their tool writes one, and that tool's PR adds the entry.
opportunity.accept has an entry: nothing proposes it, so its only payload is
a Hermes tool call the hook routes to it (Index's accept_opportunity and
reject_opportunity, the plugin's index_update_opportunity), quoted as `{tool,
input}`. The control plane's copy carries the same entry since cp#108 added
the row (its say test wants every entry to be a class row of the same file).

The relay's quiet hold reads the `ttl:` row from the card's text; the minimal
card keeps that row inside "Full details", so `always: [ttl_remaining_ms]`
stays and the hold works unchanged (core pins it:
tests/channels-telegram-minimal.test.ts, requirement 6b). A daemon before
0.4.1 refuses `style` and `say` and fails every class closed; the fleet runs
0.4.2. The switch to this block reaches a box only through the operator's
amendment: core's attestation diff budget (2400 characters, 60 lines) is
smaller than the block's diff, so a resident-attested box cannot take it until
core counts a `say` change per class (the control plane's RAILWAY.md, "Rollout
of the minimal approval card").

Dogfood tenants may add `supervised-retro` with a `retro_rate` on network.call
or message.send to exercise the review card. Residents get no review cards on
day one. No `budgets` block: proposals carry no cost.
-->

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: autonomous          # the recorder: record everything, block nothing
  channel: telegram
  approval_ttl: 72h             # the proposal window; hook-opened requests still clamp to 240 s
  on_expiry: reject
  token_delivery: sealed
  unmapped_tool: record         # a hooked tool no tools line names is recorded (harness.tool.unmapped); ask would hold it for a tap

approvers:
  resident:
    channels: [telegram]
    senders:
      telegram: "<telegram_user_id>"   # written at provisioning from the pairing
      # edgeos: "<edgeos_human_id>"    # once APRV-455 admits the channel: the onboarding review attests

channels:
  telegram:
    token_env: APPROVAL_RELAY_TOKEN      # the relay credential, approvald-only env
    chat_id_env: APPROVAL_RESIDENT_CHAT  # the paired id; the control plane writes this variable
    delivery: burst                      # every unsent proposal goes out at once; paced (the default) sends the next only after the current one is answered, and the relay passes no /skip, so one ignored 72 h card would hold back every later one
    prompt:
      always: [ttl_remaining_ms]         # show the time left; the relay holds a prompt overnight only when it outlasts the night
      style: minimal            # card layout: minimal (default) | technical; the app's Approvals setting rewrites this line
      say:
        # The minimal card (approval.md 0.4.1+, APRV-489): one message, "Your agent wants to <does>", the
        # request's own words in a box under the labels below, the time left, Approve/Deny, and the whole
        # technical card folded under "Full details". `quote` names EVERY field the request may carry:
        # a label shows the field, ~ keeps it off the card (the card then says "Not shown here"), and a
        # request with a field not named here gets the technical card instead. The agent's one-line summary
        # shows under the box, marked "not checked", unless the entry says `note: none`. A class with no
        # entry here gets the technical card. Core words the eight Hermes tool classes itself, so their
        # entries carry no `does`. Every key here must be a class row below (tests/approval-template-say).
        intent.publish.inferred.index:
          does: "post this on Index for others to see, as something it thinks you want"
          quote: { text: "" }         # the intention's words, alone in the box
          note: none                  # the summary only repeats the class and an id
        intent.publish.stated.index:  # asked only if the resident sets "Intents you state" to ask
          does: "post or update this on Index as something you said you want"
          quote: { text: "Post", tool: "Tool", input: "Details" }   # text from record_intention; tool and input from an Index tool call the hook routes here
          note: none
        digest.share:
          does: "share a note about you with the village or a village service"
          quote: { text: "Note", scope: "Shared with", expires_at: "Until", digest_id: ~ }
          note: none                  # the summary repeats scope, expiry and id
        village.vote:                 # the summary (shown) leads with the option's label, then the question
          does: "vote for you on a village question or treasury ballot"
          quote: { answer: "Answer", question_id: ~ }
        opportunity.accept:           # asked only if the resident sets its row to ask; only an Index tool call the hook routes here reaches it
          does: "accept or decline a connection or meeting on Index for you"
          quote: { tool: "Tool", input: "Details" }
          note: none
        message.send:   { quote: { tool: "Tool", input: "Details" }, note: none }   # these eight ask only if the resident sets their row to ask
        network.call:   { quote: { tool: "Tool", input: "Details" }, note: none }   # a terminal command is quoted by core itself, not by this map
        read.web:       { quote: { tool: "Tool", input: "Details" }, note: none }
        browser.exec:   { quote: { tool: "Tool", input: "Details" }, note: none }
        cron.manage:    { quote: { tool: "Tool", input: "Details" }, note: none }
        process.write:  { quote: { tool: "Tool", input: "Details" }, note: none }
        skill.manage:   { quote: { tool: "Tool", input: "Details" }, note: none }
        agent.delegate: { quote: { tool: "Tool", input: "Details" }, note: none }

classes:
  # The live gate, propose path only: the resident taps before these happen.
  intent.publish.*:              { autonomy: manual, agent_may_request: true }
  intent.publish.inferred.index: { autonomy: manual, agent_may_request: true }
  intent.publish.stated.index:   { autonomy: autonomous, agent_may_request: true }
  digest.share:                  { autonomy: manual, agent_may_request: true }   # DATA-96 section 5, if digests ship
  village.vote:                  { autonomy: manual, agent_may_request: true }   # the weekly question and the daily treasury ballot, DATA-99, DATA-292
  # Reserved now, built later: no tool proposes these yet, so nothing after Oct 11 is a policy amendment.
  treasury.propose:              { autonomy: manual, agent_may_request: true }   # DATA-292, reserved, live from Oct 18
  treasury.withdraw:             { autonomy: manual, agent_may_request: true }   # DATA-292, a resident's own proposal withdrawn by their agent's suggestion
  edgeos.event.write:            { autonomy: manual, agent_may_request: true }   # reserved; no tool uses this class before Oct 18; DATA-322
  edgeos.venue.write:            { autonomy: manual, agent_may_request: true }   # reserved; no tool uses this class before Oct 18; DATA-322
  # The village marketplace (reserved namespace marketplace.*) and the model reviewer: reserved, R2.
  marketplace.app.install:       { autonomy: manual, agent_may_request: true }   # reserved; installing an agentic app or MCP server from the village marketplace
  marketplace.app.action:        { autonomy: manual, agent_may_request: true }   # reserved; an installed app acting for the agent; the request payload names the app and the verb
  marketplace.app.read:          { autonomy: autonomous, agent_may_request: true }   # reserved; an installed app reads for the agent; recorded
  review.delegate.model:         { autonomy: manual }   # reserved; the resident may choose later to let a model reviewer act first; nothing acts on it today; no agent request
  resource.allocate:             { autonomy: manual, agent_may_request: true }   # reserved; the treasury/ODS allocation class: an allocation of village resources proposed for the resident
  opportunity.accept:            { autonomy: autonomous, agent_may_request: true }   # reserved; accepting or declining an Index opportunity (a connection or meeting) on the resident's behalf; Index's tools for it reach it through the hook; R3
  # odin.* (the allocator producer, DATA-255): a reserved namespace for the allocator's own classes; a comment only, no row here.
  # MoralMod, the research advisor: reserved before Oct 11, wired to the bridge in week 1.
  moralmod.assess:               { autonomy: manual, agent_may_request: true }   # reserved; MoralMod advisor, wired in week 1 after Oct 11
  moralmod.share_context:        { autonomy: human-only }   # reserved; never in October unless the resident chooses to be asked; the resident's context in a group assessment others see in aggregate
  # The gate's own organs and the resident's credentials: never the agent.
  policy.core:                   { autonomy: human-only }
  log.mutate:                    { autonomy: human-only }
  account.credential:            { autonomy: human-only }
  # A village coordinator agent messaging the resident: no coordinator sends anything in October.
  coordinator.contact:           { autonomy: human-only }   # reserved; locked in October, a resident choice later
  # Hermes tool classes (PR #569 rules): recorded, not gated, on day one.
  cron.manage:                   { autonomy: autonomous }
  process.write:                 { autonomy: autonomous }
  browser.exec:                  { autonomy: autonomous }
  skill.manage:                  { autonomy: autonomous }
  agent.delegate:                { autonomy: autonomous }
  message.send:                  { autonomy: autonomous }
  network.call:                  { autonomy: autonomous }
  read.web:                      { autonomy: autonomous }
  # Housekeeping inside the sandbox runs and is recorded.
  files.delete.scratch:          { autonomy: autonomous }

# The agent's tool names (approval.md 0.4.2, APRV-499): the class a hooked tool call is judged
# under when core's Hermes adapter does not class it itself. First match wins; a tool no line
# names is recorded under harness.tool.unmapped (defaults.unmapped_tool). Every class is a row
# above, so the settings page prices these calls with no row of its own. The hook sees only the
# tools the overlay routes to it (its gated list), so a line for a tool outside that list waits
# for the list to grow. A daemon before 0.4.2 refuses this key and fails every class closed.
tools:
  # Hermes's own tools that core already classes from the call's arguments (cronjob_manage list
  # and the process reads are reads there): core's table wins over these lines, and each says
  # the class that table gives, so the file reads as what happens.
  - { match: cronjob_manage,                   class: cron.manage }
  - { match: cronjob,                          class: cron.manage }
  - { match: process_manage,                   class: process.write }
  - { match: process,                          class: process.write }
  - { match: "browser_*",                      class: browser.exec }
  - { match: skill_manage,                     class: skill.manage }
  - { match: delegate_task,                    class: agent.delegate }
  - { match: send_message,                     class: message.send }
  # Reading the web.
  - { match: web_search,                       class: read.web }
  - { match: web_extract,                      class: read.web }
  - { match: x_search,                         class: read.web }
  # Index's MCP server (Hermes names its tools mcp__index__<tool>): a read is read.web; a new or
  # reworded intention in the resident's words is intent.publish.stated.index; accepting or
  # declining an opportunity is opportunity.accept; every other Index tool reaches Index as
  # network.call.
  - { match: mcp__index__get_my_profile,       class: read.web }
  - { match: mcp__index__list_intents,         class: read.web }
  - { match: mcp__index__get_intent,           class: read.web }
  - { match: mcp__index__list_opportunities,   class: read.web }
  - { match: mcp__index__get_opportunity,      class: read.web }
  - { match: mcp__index__create_intent,        class: intent.publish.stated.index }
  - { match: mcp__index__update_intent,        class: intent.publish.stated.index }
  - { match: mcp__index__accept_opportunity,   class: opportunity.accept }
  - { match: mcp__index__reject_opportunity,   class: opportunity.accept }
  - { match: "mcp__index__*",                  class: network.call }
  # Index's Hermes plugin, where installed (bare index_* names): the same split. Its
  # index_update_opportunity sets an opportunity's status (PATCH /opportunities/{id}/status): its
  # accept or decline.
  - { match: index_read_intents,               class: read.web }
  - { match: index_list_intent_networks,       class: read.web }
  - { match: index_read_networks,              class: read.web }
  - { match: index_read_network_memberships,   class: read.web }
  - { match: index_list_opportunities,         class: read.web }
  - { match: index_read_docs,                  class: read.web }
  - { match: index_agent_me,                   class: read.web }
  - { match: index_create_intent,              class: intent.publish.stated.index }
  - { match: index_update_intent,              class: intent.publish.stated.index }
  - { match: index_update_opportunity,         class: opportunity.accept }
  - { match: "index_*",                        class: network.call }
  # record_intention is left out on purpose: it is not routed to the hook, and an ask on
  # intent.publish must never block capturing an intention.
  # Tools that send content to a model provider.
  - { match: image_generate,                   class: network.call }
  - { match: video_generate,                   class: network.call }
  - { match: text_to_speech,                   class: network.call }
  - { match: vision_analyze,                   class: network.call }
  - { match: video_analyze,                    class: network.call }
```
