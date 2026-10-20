# Contextsling CX-2 draft bundle

Dark admin-pilot integration. No registration, rollout, flags or provider activation
is included. Exact operation/version/skill projection matches CP and installer.
The v1 manifest and closed event declarations live beside the bridge, outside
the reviewed v2 `mini-apps/` catalog. The manifest's `listed: false` keeps the
pilot excluded from catalogue discovery; it does not replace the control
plane's per-tenant install/activation gates. These metadata files are test and
parity inputs; the bridge and installer do not load them at runtime.
Admin pilot setup: after Contextsling is installed and the runtime restart has
finished, the admin must start a **NEW chat** before trying Contextsling. Hermes
keeps the tool schema pinned in an existing chat; a restart does not add these
installed-only operations to that chat. Verify the new chat loads the installed
Contextsling skill and named operations before testing the connector.

The sole context ceiling is `_contextsling.CONTEXT_CEILING = agentvillage/private`
under agentvillage.visibility/1; no context namespace read or write is granted.

The native Python renderer mirrors CP/app contextsling-approval.js; shared JSON
vectors pin canonical UTF-8, SHA256 and exact card text. App prepare enforces the
same 16 KiB payload, 4096 raw / 3000 HTML-escaped byte card limits. The control
plane independently verifies the daemon's exact manual request/grant/start,
owner pairing, install generation and 60-minute deadline. App verifies the
connection generation and dispatches only bytes rebuilt from its sealed proof.

Overlay caches the immutable server-returned approvalPayload in
`$HERMES_HOME/contextsling-drafts/<draftId>.json`: directory 0700, file 0600,
no tokens or result URLs. This native local plaintext custody is distinct from
the app's sealed durable draft. Success and terminal decline/disconnect errors
replace it with a minimal operation/draft/hash tombstone; expiry is cleaned on the next
owner turn, withdrawing a still-pending daemon request first. Uninstall removes
only known cache filenames. These actions do not promise secure erasure; the
box's append-only approval log retains the complete inline card even if denied.

Events are declared in events.schema.json, never emitted by this draft. A data
owner release must register closed verbs before event flow; use the existing
per-tenant plugin token and consent gate, never a shared token. The generic
tool.call event already carries only keyed hashes/lengths, never tool bodies.
Drafts, receipts and capability URLs must remain excluded from ODS/research.

Current main rejects cron before any operation. No background dispatcher or
post-tap hook is added. A tap waits for the next owner turn; rejection is
terminal and retrying pending approval uses its first task and draftId.

Expired and completed tombstones retain the original owner/origin plus minimal
operation/draft/hash identity. Same-operation retries send no approval proof:
the app permits only read-only recovery of sent/confirmed intents and refuses
prepared intents. Expiry forbids further writes; it does not prove no earlier
publication. Unknown/error daemon wait answers keep pendingWithdrawal for the
next turn. A re-pairing/origin change cannot prevent local expired-byte cleanup,
and the new owner is never used to withdraw the original owner's daemon task.

Crash cleanup recognizes only `<draftId>.json` and `<draftId>.tmp-<32 lowerhex>`
regular files, without following symlinks. Complete body-bearing orphan records
use their validated expiry; malformed/partial recognized files are deleted only
once their modification age reaches 60 minutes. Active unexpired temporary files
and unrelated filenames are preserved. Uninstall removes the recognized regular
temporary names too, after revoking the projection.

A rejected native daemon task also queues the app's restrictive internal
`{operation,draftId,declined:true}` marker: prepared → declined erases the sealed
app draft, with no provider effect and no ability to downgrade sent/confirmed.
The external tool still accepts only operation/draftId. A failed marker sync
keeps the local draft terminal, body-free and never re-proposed; the next matching
owner turn/attempt retries only that cancellation under current install/binding.
