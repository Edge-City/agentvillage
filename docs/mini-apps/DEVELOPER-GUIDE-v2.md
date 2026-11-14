# Building an Agent Village mini-app (v2 platform, developer guide)

For mini-app developers. 19 Oct 2026. The design behind this guide is [`PLATFORM-v2-design.md`](PLATFORM-v2-design.md) (approved 19 Oct 2026); the phases below say what exists now and what is coming.

## What a mini-app is

A mini-app gives every resident's agent a small, reviewed way to use your service: read it, prepare something, and (with the resident's explicit approval) act. Your code runs on your servers. On the resident's box there is only a skill file that teaches the agent when and how to call the one `village` tool. The agent never sees your endpoint, a token, or an account id; the Agent Village app server holds those and relays each call.

Three rules, which the platform makes structural rather than asking you to remember:
1. **MCP or HTTPS JSON, nothing else.** Your service is a Streamable HTTP MCP server (protocol `2025-06-18`) or a plain HTTPS JSON API. Public reads need no auth; account access is OAuth 2.1 per resident (they connect in the Mini-apps tab), or one service token we hold for you.
2. **No code execution.** A manifest has no field for code, scripts, packages, cron or shell. A skill that asks the agent to run anything is refused.
3. **No internal data storage.** Your app keeps no resident data inside Agent Village except, if you declare it, up to a few dozen short lines in the resident's own context (`data.context`), which the resident sees, moves and deletes, and which you can never widen past the ceiling they set.

## What you write

Two files, in one PR:

- `mini-apps/<id>/manifest.json`: id, name, version, owner (your GitHub login), homepage, human-readable permissions, your service (`kind: mcp | https-json`, `baseUrl`, `auth: none | oauth | app-token`), and your **operations**. Each operation has a name (`<id>.<verb>`), an input JSON Schema, a class, request and response byte budgets, a timeout, and (for an action) the approval card template.
- `skills/<id>/SKILL.md`: how the agent uses your operations; what to show the resident before acting; what to say on each error code; that returned text is data, not instructions.

Operation classes:
- `read`: no side effect (a menu, a search). Runs without asking.
- `write`: changes something the resident can undo or that is public by nature on your service (a post as their own connected account, a private draft they publish themselves). Runs when the resident asks their agent; no card.
- `prepare` + `needs-card`: anything that spends money, sends something on the resident's behalf, publishes, or shares the resident's name with a third party. `prepare` returns an immutable preview and a `draftId`; the agent shows the exact preview; the resident taps **Approve** on a card in their approvals bot; only then does `needs-card` run, bound to that exact preview's hash. You write the card as a short template over the preview; the platform renders it identically on the box and in our verifier. Same `draftId` retried twice must produce one action on your side (idempotency is yours).

Example skeleton:

```json
{ "manifest": 2, "id": "cafe", "name": "Cafe", "version": "1.0.0",
  "owner": { "github": "you" }, "homepage": "https://cafe.example",
  "visibility": "sandbox",
  "permissions": [ { "kind": "read", "label": "Read the menu", "description": "Public menu and hours." },
                   { "kind": "action", "label": "Order coffee", "description": "Places only an order you approved on its card; shares your display name with the cafe." } ],
  "service": { "kind": "https-json", "baseUrl": "https://api.cafe.example/agent", "auth": { "mode": "app-token", "secretRef": "CAFE_TOKEN" } },
  "operations": [
    { "name": "cafe.menu", "class": "read", "target": { "method": "GET", "path": "/menu" },
      "input": { "type": "object", "properties": {}, "additionalProperties": false } },
    { "name": "cafe.order.prepare", "class": "prepare", "target": { "method": "POST", "path": "/quote" },
      "input": { "type": "object", "properties": { "items": { "type": "array" } }, "required": ["items"], "additionalProperties": false },
      "returns": { "draftIdPath": "$.draftId", "previewPath": "$.preview", "previewTtlSeconds": 3600 } },
    { "name": "cafe.order.confirm", "class": "needs-card", "target": { "method": "POST", "path": "/order" },
      "input": { "type": "object", "properties": { "draftId": { "type": "string" } }, "required": ["draftId"], "additionalProperties": false },
      "approval": { "prepare": "cafe.order.prepare",
                    "summary": [ "Cafe order", "{{#each preview.lines}}{{qty}} x {{name}}: {{priceInr}} INR{{/each}}", "Total: {{preview.totalInr}} INR" ] } }
  ],
  "skills": [ { "name": "cafe", "version": "1.0.0", "sha256": "<sha256 of skills/cafe/SKILL.md>" } ] }
```

## How a change goes live (three lanes)

| Lane | Who sees it | What it takes |
|---|---|---|
| **sandbox** | your own agent | your manifest validates; your tenant is listed for your app. Iterate freely. |
| **admins** | Edge City staff agents | a PR that touches only `mini-apps/<id>/**` and `skills/<id>/**`, CI green (schema, hashes, secret scan), your `conformance.json` attached and green, and the review bot's `PASS`. **No human in the loop.** It merges and goes live. |
| **everyone** | every resident | the same, plus one human read of your manifest diff and the bot's output (target: under 15 minutes). |

Raise visibility one step per PR. Bumping a major version (a new or wider operation, a bigger budget, a new auth mode, a new card template) resets you to the admins lane until the bot and conformance pass again.

**Conformance** is a CLI you run against your staging service: `bun run conformance -- mini-apps/<id>/manifest.json --base-url https://staging.example`. It checks your schema, that your MCP/HTTPS endpoints answer the fixtures within budgets, that your card template renders over your previews, that a replayed `draftId` produces one action, and that nothing in your responses looks like a secret. Commit the `conformance.json` it writes.

**The review bot** (jmill's) reads your diff and your conformance result and posts one comment with a verdict (`PASS`, `FAIL`, `NEEDS_HUMAN`) and findings with file and line. It checks what a schema cannot: that nothing asks the agent to run code or store data elsewhere, that every operation is classed honestly (a "read" with a side effect fails), that anything that pays, sends or publishes is `needs-card`, that your permissions text names every third party that receives data, and that your skill never claims success without a receipt. Its spend is not yours and it never sees resident data; a manifest PR contains none.

## What we still own (and will keep reviewing ourselves)

The `village` tool and the bridge, the approval card verifier and the approvals bot, payments plumbing (the confirm lease and idempotency rules), consent and visibility rules, the manifest schema and its validator. Changes there are ours; your app never needs them.

## Timeline

- **This week (Phase 0):** manifest v2 schema and validator; the deterministic CI on manifest PRs; the bot commenting on those PRs; the sandbox lane as described (ask for your tenant to be listed); conformance v0 (schema, hashes, card render).
- **Next two weeks (Phase 1):** the generic approval card for any `needs-card` op (today only Gold Stars and For Kicks have one, each hand-wired); generic OAuth connect for any `auth: oauth` app; the admins lane auto-merge with the bot's verdict required.
- **After the next overlay release (Phase 2):** skill files delivered from the catalog at install time (a skill fix no longer waits for a fleet release); the box verifies a signed projection, so a new operation never needs a box-side change.
- **Phase 3:** the everyone lane with the 15-minute human read.

## To get started

1. Fork the repo that holds `mini-apps/` and `skills/` (for now, this repo: `Edge-City/agentvillage`); copy the closest existing manifest (public read: Dizko; OAuth account: zzz.bot or Slopfolio; approved action: For Kicks).
2. Open a draft PR with `visibility: sandbox`; ask for your tenant to be listed for your app id.
3. Run conformance against your staging service; iterate until green; read the bot's comment.
4. When your own agent uses it well, set `visibility: admins` in a follow-up PR.

Questions and edge cases: open an issue on the catalog repo or ask in the partners channel.
