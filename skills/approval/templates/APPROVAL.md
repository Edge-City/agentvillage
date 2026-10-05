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

The treasury and EdgeOS rows are reserved now and built later: no tool
proposes them yet, and writing them before Oct 11 means week two's
experiments need no policy amendment (a change to every tenant's policy
bytes, and so a re-attestation, after enforcement starts).

A resident may change these in the onboarding review (DATA-259); the rows below
are the defaults.

intent.publish.stated.index is autonomous: an intention the resident stated in
their own words is published without a second ask, and still recorded.
`agent_may_request: true` is what opens `propose` to a class; it exists in the
core schema from approval.md 0.4.0 (PR #569), so this policy needs a daemon at
0.4.0 or later. On an older daemon the schema rejects the key and the policy
resolves every class manual (fail closed).

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

The three organ rows are mandatory under an autonomous default. Core classifies
the Hermes home's config.yaml, agent-hooks/, hooks* and the consent allowlist as
policy.core, and .env and auth.json as account.credential (APRV-415). Without
these rows an autonomous default would let the agent edit its own gate or read
the resident's credentials. log.mutate keeps the daemon's log out of reach for
the same reason. Core refuses `agent_may_request` on a human-only class at
load, so these rows carry none.

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
prompt reaches the resident through the "Agent Village Approvals" bot.
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
  # The gate's own organs and the resident's credentials: never the agent.
  policy.core:                   { autonomy: human-only }
  log.mutate:                    { autonomy: human-only }
  account.credential:            { autonomy: human-only }
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
```
