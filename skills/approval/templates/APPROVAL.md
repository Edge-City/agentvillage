# Approval Policy (Agent Village resident, starting template)

<!--
DOCUMENTATION ONLY. The installer does NOT write this file into the sandbox.

The policy lives with the resident's approval.md daemon, not in the Hermes
sandbox: the daemon reads the tenant's attested APPROVAL.md, and "a sandboxed
Hermes tenant has no local log and no local policy" (approval-md-hosted
docs/02 sections 1 and 5). An operator copies this template into the tenant's
store on the daemon, fills the placeholders, and a human attests it
(`approval policy attest --as human:<approver>`); until then every gated call
refuses `policy-not-attested`.

Shape from approval-md-hosted docs/03 section 5: defaults autonomous, a short
list of manual classes for actions with consequences outside the sandbox.
Placeholders:

  <approver>      the resident's approver id (lowercase, e.g. the tenant slug)
  <telegram_id>   the resident's telegram_user_id, from the control plane
                  (approvers.<id>.senders; written at provisioning)
  <TENANT>        the tenant slug, uppercased, '-' as '_' (docs/02 section 7.1:
                  tenant-prefixed credential NAMES, never the core defaults)

Class names, checked against the core classifier (approval-md
src/core/command-class.ts at 6b74ca72):

  - network.call, files.delete.out_of_scope, files.delete.scratch,
    policy.core, log.mutate and account.credential are classes the classifier
    emits today.
  - message.send, money.spend, content.post and files.delete are the classes
    docs/03 section 5 names. The classifier has no rule that emits them yet,
    so they only take effect once one exists; until then a message send, a
    payment or a post made through `terminal` (curl and the like) classifies
    as network.call, which is manual below.
  - "network.call beyond the Index and EdgeOS APIs": the policy has no
    per-host scope at this version, so network.call is manual for every host.
    Index runs over MCP (not gated) and EdgeOS through the overlay's skill
    scripts; whether those scripts classify as network.call is checked on the
    dogfood tenant (gate item 2) before residents are offered the skill.

  - read.web is MANUAL here, unlike a developer policy. The classifier gives a
    GET-shaped curl or wget `read.web`, and a GET can send: a Telegram Bot API
    `sendMessage?chat_id=…&text=…` is a GET. Autonomous read.web would let a
    message out of the sandbox with no tap.
  - Deleting files: an `rm` inside the workspace classifies
    `files.write.workspace` (autonomous under these defaults), so only deletes
    outside it (files.delete.out_of_scope) wait for the resident. The consent
    copy says "delete files outside its workspace" for that reason.

The read roots are the daemon host's, not the sandbox's. The hook envelope's
paths are sandbox paths (/home/hermes/.hermes/…), which fall outside every read
root on the daemon host, so a file read the classifier judges by path comes back
`read.file.out_of_scope` rather than an in-workspace read (approval-md-hosted
docs/03 section 8). That denies, which is the safe direction, but read-scope
verdicts differ from a co-located hook. Decide read.file.out_of_scope's
autonomy knowingly. This template leaves it to defaults.autonomy (autonomous),
so reads run and are recorded.

Hermes caps the human's window at the hook's 300 s entry timeout. The runtime
judges requests against the harness cap minus 60 s (APRV-423), so a resident
has about four minutes, which is also approval_ttl below (4m).
-->

```yaml approval-policy
version: "0.1"

defaults:
  autonomy: autonomous
  channel: telegram
  approval_ttl: 4m
  on_expiry: reject

approvers:
  <approver>:
    channels: [telegram]
    senders:
      telegram: "<telegram_id>"

channels:
  telegram:
    token_env: HOSTED_<TENANT>_TG_BOT_TOKEN
    chat_id_env: HOSTED_<TENANT>_TG_CHAT

classes:
  # Consequences outside the sandbox: the resident taps first.
  message.send:              { autonomy: manual }
  money.spend:               { autonomy: manual }
  files.delete:              { autonomy: manual }
  files.delete.out_of_scope: { autonomy: manual }
  content.post:              { autonomy: manual }
  network.call:              { autonomy: manual }   # every host at this version; see the note above
  read.web:                  { autonomy: manual }   # a GET can send (Telegram sendMessage); see the note above
  # Housekeeping inside the sandbox runs and is recorded.
  files.delete.scratch:      { autonomy: autonomous }
  # The gate's own organs and the resident's credentials: never the agent.
  policy.core:               { autonomy: human-only }
  log.mutate:                { autonomy: human-only }
  account.credential:        { autonomy: human-only }
```
