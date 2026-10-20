# Mini-apps platform v2: a faster, safer development cycle (design)

> **Status (19 Oct 2026).** Approved by Carter with the six defaults in [Questions for Carter](#questions-for-carter-each-with-a-default-answered-defaults): admins lane fully unattended; manifests stay in this repo for now (own repo in Phase 2); third-party needs-card ops always ask the resident (no autonomous rows); write-class ops get no new consent gate; context ceiling default private; our Action merges, the review bot comments/checks; everyone-lane reviewer = the platform lead. Phase 0 starts this week.

Design by the platform team, Mon 19 Oct 2026. The companion developer guide is [`DEVELOPER-GUIDE-v2.md`](DEVELOPER-GUIDE-v2.md).
Repository heads this design was read against: cp origin/main `5c9329f`, app origin/main `5c7f50e9`, overlay origin/main `40988960`.
Inputs: Carter's 19 Oct approval of "a faster, safer mini-app development cycle"; jmill: "this is a bummer for your attention being spof for non-core backend changes" and "it needs to just be MCPs or skill files. no code execution, no internal data storage", plus his PR-review bot prototype (Odin's Claude subscription, Edge City infra); jmill's own one-paragraph framing of the context rule, shared separately ("Happy to have your PR-review bot check exactly that: data.context declared + bounds + no other storage").

## 0. Today's reality, in one table

Every mini-app today is five hand-written code changes in four repos that must agree byte for byte, plus a fleet roll. The evidence:

| Layer | Where (file:line) | What is hand-written per app today |
|---|---|---|
| cp catalog | `control-plane/src/mini-apps-catalog.js:3-70` | five JS constants (`GOLD_STARS`, `DIZKO`, `ZZZBOT`, `SLOPFOLIO`, `FORKICKS`); `restricted: true` at :39 and :51; `data.context.maxEntries` only on Dizko at :27; `APPS` at :119 and `NEWEST_APPS` at :122; per-box variants `DIZKO_CONTEXT` :79-82 and `GOLD_STARS_PERSON` :92-97 chosen by release-tag floors (`PERSON_FLOOR_TAG` :147, `CONTEXT_FLOOR_TAG` :186) because an older overlay "refuses this list and then loses every gold-stars op" (:85-86) |
| cp visibility | `mini-apps-tenant-allowlist.js:12,45-49` | one env var `MINI_APPS_TENANT_ALLOWLIST` `{app: [tenant uuids]}`; fails closed; the only "sandbox" that exists |
| cp approval | `mini-apps-approval.js:98-127` | `request()` admits exactly two (appId, operation) pairs: `gold-stars`/`gold-stars.send` (:156) and `forkicks`/`forkicks.order.confirm` (:159); the For Kicks card text is hand-coded in `forkicksSummary()` :35-67 and "Mirrored by overlay `_forkicks.approval_summary`" (:34) = a cross-repo byte-equality contract; `ACTION_KEY_PREFIXES` :252 lists the three keys by hand |
| cp app context | `context-app-namespaces.js:67-73` | reads `data.context.maxEntries` from the catalog entry; every app line is written PRIVATE (`scopes {agent, app:<id>}`, :113-125); only the resident widens (:8-11) |
| app bridge HTTP | `src/lib/server/village-bridge/http.ts:16-17,56-61,103-116` | per-op request budgets in a hand table: unframed 4 KiB, `slopfolio.prepare` 256 KiB, `zzz.reply`/`zzz.create_thread`/`forkicks.order.confirm` 64 KiB, plus an unframed For Kicks exception (:114-116) |
| app bridge dispatch | `village-bridge/service.ts:252-287` | `ToolRequest` is a zod discriminated union of every op's input, hand-written; `runTool` :371-376 derives the appId from the op prefix by hand (`isZzz` -> zzzbot, `forkicks.` -> forkicks, `slopfolio.` -> slopfolio, else `appId` or gold-stars) then dispatches op by op (:379-454) |
| app MCP relay | `mini-apps/mcp.ts:93-99` | the one generic path (`callReviewedMcp`) refuses zzzbot and slopfolio by id; `validateMcpArguments` :20-33 already compiles the reviewed input schema with ajv (the pattern v2 generalises) |
| app catalog zod | `mini-apps/catalog.ts:42-61` | `MiniAppDefinition` (id, name, description, version, homepage, permissions, skills, operations, mcp?, credit?, data?); `data.context.maxEntries <= 64` (:22-25); `requireMiniAppOperation` :139-145 = "Installation is authority" |
| app per-app code | `mini-apps/service.ts:104-105,187,195-202,239-244` and `mini-apps/{zzzbot,slopfolio}/*` (10 files each, `git ls-tree`) | per-app env flags in the catalog filter, per-app install/uninstall hooks, per-app OAuth connect/callback/disconnect/status routes (`src/app/api/v1/mini-apps/{slopfolio,zzzbot}/*`), per-app grants tables (migrations 0089-0092, 0096) |
| app approval payload | `mini-apps/approval.ts:5-21` | `GoldStarPreview`/`GoldStarApproval` literal to gold-stars; For Kicks has its own in `village-bridge/forkicks-schema.ts` |
| overlay projection check | `plugins/village-bridge/_mini_apps.py:16-27,48,50,56` | exact-equality constants for gold-stars (three accepted lists), forkicks, zzzbot, slopfolio; generic apps only `["mini-app.read"]` or the 3-op context list (:56); `installed()` :81-121 refuses the whole projection on any other list |
| overlay tool schema | `plugins/village-bridge/__init__.py:47` | the `operation` enum is a hard list of 20 names; `schema_for` :183-189 appends zzz ops only when installed; `handle()` :785-943 whitelists each op's argument keys by hand; `transport()` :711-728 hand-codes 64 KiB for `forkicks.*`, the `X-Village-Operation` header for four writes (:717-719), 60 s vs 25 s timeouts (:724), response limits 262144 / 65536 / menu-image (:728) |
| overlay approval | `_mini_apps.py:140-180` `authorize_send` (gold-stars only) and `_forkicks.py:127-147` `authorize_order` (forkicks only) | two near-copies of propose -> wait -> start |
| overlay installer | `install/install_miniapps.ts:20-39` | `REVIEWED_MINI_APPS` + `PREVIOUS_REVIEWED_MINI_APPS` tables by exact match (:74-75); skills copied from the checkout's `../skills` (:91) |
| skill delivery | cp `mini-apps-runtime.js:50` | `cd "$HOME/.hermes/edge-src" && ... bun install/install_miniapps.ts` = skill bytes come from the box's pinned overlay checkout, so **any skill text change needs a fleet roll** |
| manifest | `mini-apps/<app>/manifest.json` (e.g. `forkicks/manifest.json:12`) | a review artifact only; `mini-apps/README.md:50-54` says "Submit the same reviewed definition to the control-plane catalog. Update `install/install_miniapps.ts`'s reviewed bundle table" |

What this cost on For Kicks (one app, one developer, 18-19 Oct): ov#378 (jmill, merged 18 Oct 16:57Z), ov#399 (ours: framing + the 409, merged 20:07Z), cp#286 (merged 19 Oct 02:54Z after a fold, "Merge-up 2 (after cp#294)" and "Merge-up 3 (after cp#314)", per its build notes), app#377 (merged 19 Oct 03:04Z after six heads: M1 pool, M2 lease, merge-up onto Slopfolio, fold 2 stamps, fold 3 lease, merge-up after zzz, per its build notes), skills#18 (still OPEN). Each merge-up was forced because another app (Slopfolio #388, zzz #442) had edited the same hand tables in `http.ts` and `service.ts`. The zzz.bot design priced its app at "roughly 8 files + 1 migration" and said "Copy Slopfolio file for file" (zzz.bot design §2). The contextsling plan review found the card "hard-coded to Gold Stars on both sides" (finding M1). That is the attention SPOF jmill names.

What already works and v2 keeps: installation is authority (`catalog.ts:138-145`); the cp catalog is the only source of endpoints and schemas (`mini-apps/README.md:61-64`); the box never holds a token, endpoint or account id (zzz design §2); every result is framed as untrusted data (`__init__.py:29`, `:1031,1050`); the approval daemon's own log is the proof, never a model claim (`mini-apps-approval.js:1-2`); prepare -> exact preview -> confirm for anything that spends.

## 1. Manifest-driven catalog

One JSON document per app is the whole definition. The cp stores and validates it; the app and overlay are driven by it. No per-app cp, app or overlay code for an app that stays inside the manifest's vocabulary.

### 1.1 Schema (v2), by field

```json
{
  "manifest": 2,
  "id": "forkicks",
  "name": "For Kicks",
  "version": "1.1.0",
  "description": "Read the café menu and schedule, and order with an exact approved preview.",
  "homepage": "https://...",
  "owner": { "github": "jmilldotdev", "org": "For Kicks" },
  "credit": { "role": "product", "attendeeId": "<uuid>", "name": "..." },
  "visibility": "sandbox",
  "permissions": [ { "kind": "read", "label": "...", "description": "..." } ],
  "service": {
    "kind": "mcp",
    "baseUrl": "https://mcp.example.com/mcp",
    "auth": { "mode": "oauth",
              "oauth": { "resource": "https://mcp.example.com/mcp", "scopes": ["x:read", "x:write"],
                         "discovery": "https://mcp.example.com/.well-known/oauth-authorization-server" } }
  },
  "operations": [
    { "name": "forkicks.menu", "class": "read",
      "target": { "tool": "menu" },
      "input": { "type": "object", "properties": { "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" } }, "additionalProperties": false },
      "maxRequestBytes": 4096, "maxResponseBytes": 262144, "timeoutMs": 25000,
      "framing": "data" },
    { "name": "forkicks.order.prepare", "class": "prepare",
      "target": { "tool": "quote" }, "input": { "...": "..." },
      "maxRequestBytes": 4096, "maxResponseBytes": 65536, "timeoutMs": 25000,
      "returns": { "draftIdPath": "$.draftId", "previewPath": "$.approvalPayload", "previewMaxBytes": 60000, "previewTtlSeconds": 3600 } },
    { "name": "forkicks.order.confirm", "class": "needs-card",
      "target": { "tool": "place_order" }, "input": { "type": "object", "properties": { "draftId": { "type": "string" } }, "required": ["draftId"], "additionalProperties": false },
      "maxRequestBytes": 65536, "maxResponseBytes": 65536, "timeoutMs": 60000,
      "approval": { "prepare": "forkicks.order.prepare",
                    "summary": [ "For Kicks order", "{{#each preview.quote.lines}}{{qty}} × {{name}}; unit ₹{{unitInr}}{{/each}}", "Total: ₹{{preview.quote.totalInr}}", "Payment: {{preview.paymentMethod}}" ],
                    "summaryMaxBytes": 3000 } }
  ],
  "data": { "context": { "maxEntries": 16, "ceiling": "village" } },
  "skills": [ { "name": "forkicks", "version": "1.0.3", "sha256": "<64 hex>", "path": "skills/forkicks/SKILL.md" } ],
  "events": { "miniapp.forkicks.order@1": { "orderId": "string", "totalInr": "integer" } }
}
```

Field rules (all enforced by the cp validator; the app's zod and the overlay's checker consume the cp's validated copy, never the file):

- `id`: `^[a-z][a-z0-9-]{0,39}$` (the cp's `APP_ID_RE`, the app's `MINI_APP_ID`: one rule, `catalog.ts:43`). Immutable once published.
- `version`: semver. A manifest change that adds or widens an operation, raises a budget, adds `data`, changes `service.auth`, or changes a `needs-card` summary template is a **major** bump; copy, descriptions, skill text and tightened schemas are minor/patch. The bot checks the bump (§6).
- `owner.github`: the GitHub login(s) that may open PRs for this id (the bot refuses a manifest PR from anyone else: §6). No emails.
- `visibility`: `sandbox` (only the tenants named for this app in the allowlist, exactly today's `restricted: true` + `MINI_APPS_TENANT_ALLOWLIST`), `admins` (every admin tenant: the platform's admin role list), `everyone`. Replaces the boolean `restricted` and the per-app env flags `zzzEnabled()` / `slopfolioEnabled()` (`mini-apps/service.ts:105`).
- `service.kind`: `mcp` (Streamable HTTP, protocol `2025-06-18` as `mcp.ts:107-113` pins) or `https-json` (For Kicks' `/api/agent/*`: `target: { method, path }`). `baseUrl` is HTTPS, no userinfo, no query, no fragment (`catalog.ts:15-18`); redirects refused (`mcp.ts:105 redirect: "error"`).
- `service.auth.mode`: `none` (public reads: Dizko), `oauth` (per resident; the app server holds the grant, the box never sees it: zzz design §2), `app-token` (one merchant token the app holds in a named env var `secretRef`, as For Kicks' merchant bearer today). The manifest names the variable, never its value.
- `operations[].name`: `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$`, first segment = `id` (or `mini-app` for the generic context ops the cp appends). Max 32 ops.
- `operations[].class`: `read` (no state change; may run autonomously under `marketplace.app.read`), `write` (changes state the resident can undo or that is public-by-nature, e.g. a zzz post, a context save; runs with `gate_verified()` and no card, exactly today's `WRITE_OPERATIONS` path `_mini_apps.py:42-43`), `prepare` (stages an immutable preview; a write of a draft only), `needs-card` (executes a staged preview after the resident's grant: pays, sends, publishes, shares a name with a third party). The bot forces `needs-card` on any op whose description or target spends, sends or publishes (§6).
- `operations[].input`: JSON Schema 2020-12, compiled with ajv `strict: true` and `additionalProperties: false` forced (`mcp.ts:16,23`). Max 16 KiB of schema.
- `maxRequestBytes` (default 4096, ceiling 262144 unless `needs-card`, ceiling 65536 for a needs-card confirm), `maxResponseBytes` (default 262144, ceiling 25 MiB only with `framing: "media"`), `timeoutMs` (default 25000, max 60000; 60000 allowed only for `needs-card`).
- `framing`: `data` (the result is wrapped `{data, handling}` after `scrubbed_tree`: `__init__.py:1031,1050`) or `media` (PNG pages as For Kicks' menu image, `_forkicks_media.py` bounds). No other value.
- `approval` (needs-card only): `prepare` names the op whose stored preview this executes; `summary` is a list of lines in a tiny deterministic template grammar (§3.2); `summaryMaxBytes` ≤ 3000 escaped (today's constant, `mini-apps-approval.js:65`).
- `data.context`: `maxEntries` 1..64 (`catalog.ts:22`), `ceiling` the widest section the app may ever request for a line (`private` default; see §7). `data.state`/`data.events` follow the mini-apps data proposal (a separate proposal), §3; `events` are declared verbs with closed payload schemas, ids/counts/hashes only.
- `skills[]`: name = id (today's rule `_mini_apps.py:114 app["skills"] != [name]`), version, `sha256` of the SKILL.md bytes, repo path. The hash is what the box verifies (§4).
- Forbidden: any key not in the schema (the validator is closed), any `http:` URL, any string that matches the secret patterns the bot scans (§6), any `operations[].target` that is a shell command, file path or package name. There is no field for code. That is jmill's rule made structural: "just MCPs or skill files".

### 1.2 Where it lives and how the cp loads it

- Source of truth: `mini-apps/<id>/manifest.json` + `skills/<id>/SKILL.md` in one repo (Question 2; answered: this repo for now). Phase 0 keeps them in the overlay repo where they already are.
- The cp replaces the five constants with `mini-apps-manifests.js`: at boot it loads every manifest from a pinned catalog directory (`MINI_APPS_CATALOG_DIR`, defaulting to a vendored copy in the cp image), validates each against the v2 JSON Schema (ajv, strict), freezes the result, and exposes the same `definition(id)` / `projection(desired, opts)` / `APPS` / `NEWEST_APPS` surface `mini-apps.js:10,115,157-158,186,319` consume today. One module, no per-app branches. A manifest that fails validation is logged with a code and dropped; the rest of the catalog serves (the app already treats a bad `data` block that way: `catalog.ts:28-40`).
- Phase 2 adds `GET /mini-apps/manifests` (cp, API key) and `POST /mini-apps/manifests/:id` (owner token, sandbox only) so a sandbox manifest can be pushed without a cp deploy. The admins and everyone lanes still go through git (§5).
- The per-box variant machinery (`personCommit`, `contextCommit`, the three `VARIANTS` tried in `mini-apps.js:313-345`) is a transition cost of exact-equality checking on the box. It goes away once the box verifies a **signed projection** instead of a constant (§2.3). Until then the cp keeps today's floor logic unchanged.

### 1.3 What the cp validates beyond the schema

- `id` uniqueness; `version` monotonic per id; a published manifest is never edited in place (a new version is a new frozen object; `tenant_mini_apps.desired[id] = version` keeps pinning the installed one, as today).
- Every `needs-card` op names a `prepare` op in the same manifest; its summary template references only paths under `preview` and renders within `summaryMaxBytes` on the conformance fixture (§5.3).
- `data.context.ceiling` ≤ the platform ceiling for the app's visibility (sandbox/admins may declare up to `public`; `everyone` apps may not declare `public` without the human lane).
- `skills[].sha256` equals the bytes at `path` in the same commit.

## 2. One generic bridge path (app + overlay)

### 2.1 The app server: one dispatcher, data-driven

Replace the hand union and the prefix switch with:

1. **Parse**: `POST /api/v1/village-bridge/tool` reads `X-Village-Operation` (now required for every request; absent = the 4 KiB default, as today), looks the op up in this tenant's installed catalog entry (`requireMiniAppOperation` unchanged, `catalog.ts:139`), and streams the body up to that op's `maxRequestBytes` (`http.ts:56-61` becomes a lookup into the manifest, not a table). Body `operation` must equal the header (`http.ts:110-111` rule, generalised).
2. **Validate**: `{ operation, appId?, arguments }` only. `appId` is accepted only for the generic `mini-app.*` ops (today's `APP_SCOPED_OPERATIONS`, `_mini_apps.py:45`); for a manifest op the appId is the manifest's (the first name segment), never a request field. `arguments` is validated with the op's compiled schema (`validateMcpArguments`'s cache, `mcp.ts:24-31`, reused for every op).
3. **Authorise by class**: `read`/`write`/`prepare` proceed; `needs-card` requires `approval: {taskId, payloadHash, payload}` and the cp verify (§3).
4. **Execute by `service.kind` + `auth.mode`**:
   - `mcp`: today's `callReviewedMcp` with the app's `baseUrl`, `target.tool`, and, for `auth: oauth`, this resident's bearer from the generic grants table (below); for `app-token`, the env var the manifest names.
   - `https-json`: `fetch(baseUrl + target.path, { method })` with the same headers and budgets (For Kicks' `forKicks()` client generalised).
   - `prepare`: run the target, then store `{draftId, approvalPayload, payloadHash, expiresAt}` in **one generic table** `mini_app_drafts(cp_tenant_id, app_id, draft_id, payload jsonb, payload_hash, expires_at, confirm_claimed_at, receipt jsonb)` (For Kicks' 0093-0095 columns, keyed by app). `payloadHash` is `approvalHash()` (`approval.ts:35-37`) over `{appId, operation, preview}`.
   - `needs-card`: cp verify, then the lease rule from app#377 fold 3: claim `confirm_claimed_at`, release only on a definite answer, replay a stored receipt, 2-minute lapse, same idempotency key on retry. This is the one place the money logic lives, once.
5. **Bound and frame**: response read to `maxResponseBytes`, JSON parsed with duplicate-key refusal, returned as `{kind: "mini-app", appId, operation, asOf, result}`. The overlay frames it (§2.2).

Generic OAuth: one `mini_app_grants(cp_tenant_id, app_id, access_enc, refresh_enc, expires_at, scopes, generation)` table under one `MINI_APPS_TOKEN_KEY` (the per-app `ZZZ_TOKEN_KEY` / `SLOPFOLIO_TOKEN_KEY` become per-app rows encrypted under one key; migration of existing grants is a re-encrypt script, or we leave the two old tables read-only until the residents reconnect within 30 days as zzz tokens expire anyway: zzz design §1). One route set `api/v1/mini-apps/[appId]/{connect,callback,disconnect,status}` driven by `service.auth.oauth`, with per-app client ids in env vars named by convention `MINI_APP_<ID>_OAUTH_CLIENT_ID` (the manifest never carries them). Disconnect on uninstall is the generic rule, replacing `disconnectZzz`/`disconnectSlopfolio` (`service.ts:239-240`).

Core ops stay code: `rolodex.*`, `skylight.*`, `gold-stars.*` are first-party and read our own DB (`service.ts:419-454`). They are listed in a first-party manifest (`id: gold-stars`, `service.kind: "internal"`) so the same budget/framing/approval tables apply, but their handlers remain in the app. "Core stays gated" (§5) is exactly this set plus the bridge, approval binding, payments and consent.

### 2.2 The overlay plugin: a schema from the projection, not from constants

- `mini-apps.json` (the projection the cp stages, `install_miniapps.ts:50`) grows per op: `{ name, class, maxRequestBytes, timeoutMs, framing }` and per app `{ id, version, skills: [{name, version, sha256}] }`. The overlay's `installed()` (`_mini_apps.py:81-121`) stops comparing against constants and instead verifies the file's **sha256 against the cp receipt the installer wrote** (`projectionSha256`, `install_miniapps.ts:127`) and that every op's class and budgets are within the plugin's hard ceilings (the same ceilings as §1.1; a projection asking for more is refused whole, as today).
- `schema_for()` (`__init__.py:183-189`) builds the `operation` enum and the `arguments` description from the projection: every installed op, no hard list at :47. The 20 hand-coded argument whitelists in `handle()` (:815-943) collapse to: `{operation, arguments}` (+ `appId` for `mini-app.*`), arguments an object ≤ `maxRequestBytes`, forwarded unchanged; the app validates the schema (as it already does for every zzz/Slopfolio op: `mini-apps/README.md:320-323`). The plugin still adds `turnId` from the trusted session for `prepare`/`write`/`needs-card` ops (zzz/Slopfolio rule) and never from the model.
- `transport()` (:711-728) reads budgets, the header and the timeout from the op record; `READ_OPERATIONS`/`WRITE_OPERATIONS` (:40-43) become `class == "read"` / `class in (write, prepare, needs-card)`. `gate_verified()` stays the guard on every non-read.
- Framing stays the plugin's: `scrubbed_tree()` + `HANDLING` for `data`, `materialize()` for `media`. Per-app error-code tables (`ZZZ_ERRORS`, `SLOPFOLIO_ERRORS`) become a generic rule: the plugin forwards only `{error: <code>, retryable?, instruction?}` where `code` matches `^[a-z][a-z0-9_]{0,63}$` and `instruction` is the app server's fixed sentence (the app, not the merchant, authors it); upstream text never reaches the model, as today.
- Legacy acceptance during the roll: the plugin accepts both the v1 projection (today's constants) and the v2 signed projection for one release train, exactly as `GOLD_STARS_ACCEPTED` carries three lists today. The cp serves v2 only to boxes whose verified commit is at or after the v2 floor tag (reusing `personCommit`'s rule, `mini-apps-catalog.js:168-171`). After the fleet is on v2 the constants and the floor machinery are deleted.

### 2.3 What still needs a roll after v2

The plugin code (`plugins/village-bridge/*`), the installer (`install/install_miniapps.ts`), the approval shim and template, the Hermes pin, and the `village` tool's **structure** (new top-level fields or a new framing kind). Not: a new app, a new op, a budget, a skill text, a summary template, a visibility change, a context ceiling. Those are catalog data.

### 2.4 Migration of the five apps

| App | Today | v2 manifest | What changes for the resident |
|---|---|---|---|
| Dizko | `mcp`, `auth: none`, `mini-app.read` + 2 context ops; `data.context.maxEntries 16` | `service.kind: mcp`, 7 `read` ops named `dizko.<tool>` (or keep the generic `mini-app.read` with `target.tool` from arguments for one train), `data.context {maxEntries 16, ceiling: private}` | none; same skill |
| Gold Stars | first-party; send under the derived member class `marketplace.app.action.gold-stars.send` (`approval-settings.js:198`) | `service.kind: internal`; ops classed read/prepare/needs-card; `approval.summary` template reproduces "Send one Gold Star: {{preview.recipientName}}" (`_mini_apps.py:150`) | none; the member class row stays; it is the one documented exception |
| zzz.bot | `mcp`, per-resident OAuth, 5 named ops, 2 writes with `gate_verified` and no card; restricted | `service.kind: mcp`, `auth: oauth {resource https://zzz.bot/mcp, scopes}`, 3 `read` + 2 `write`, `visibility: admins`; grants row moves to the generic table on next reconnect | none |
| Slopfolio | `mcp`, OAuth, `slopfolio.prepare` (256 KiB, 0 cards) + `status`; restricted | `auth: oauth`, `slopfolio.prepare` classed `write` (it creates a private draft the resident publishes on Slopfolio: not a publish) with `maxRequestBytes 262144`, `slopfolio.status` `read` | none |
| For Kicks | `https-json` with a merchant bearer; 2 reads, prepare, confirm (card, 64 KiB, 60 s), status, cancel; menu image framing | `auth: app-token {secretRef: FORKICKS_MERCHANT_TOKEN}`, `forkicks.menu` `read` with `framing: media` variant, `order.prepare` `prepare`, `order.confirm` `needs-card` with the §3 template reproducing today's card lines, `order.status` `read`, `order.cancel` `write`; `visibility: everyone` (Carter 19 Oct, `mini-apps-catalog.js:62`) | none; the resident sees the same card |

Order: overlay (plugin accepts v2) -> cp (loads manifests, serves v2 to qualifying boxes) -> app (generic dispatcher; keeps today's per-op modules until each app's manifest is live, then deletes them). Each app flips when its manifest validates and its conformance run is green (§5.3); no resident-visible change at flip.

## 3. One generic approval card

### 3.1 The flow (any `needs-card` op)

1. The agent calls `<app>.<x>.prepare` (class `prepare`). The app server runs the target, binds the preview to the request where it can (For Kicks' `bindQuoteLines`, app#377 fold 2, becomes a manifest `returns.bind` list of `(requestPath, previewPath)` equalities), stores the draft, and returns `{draftId, approvalPayload, payloadHash, expiresAt}`. The plugin caches the payload owner-private (`$HERMES_HOME/mini-apps/drafts/<appId>/<draftId>.json`, 0600, the For Kicks cache generalised: `mini-apps/README.md:201-209`).
2. The agent shows the resident the preview and waits for a later reply (skill rule).
3. The agent calls `<app>.<x>.confirm {draftId}` (class `needs-card`). The plugin, not the model, loads the cached payload, recomputes the hash, renders the **summary from the manifest template** (§3.2), and runs the one generic `authorize_action(appId, op, draftId, payload, summary)`: propose class `marketplace.app.action`, key `marketplace.app.action:<appId>.<op>:<draftId>` (today's For Kicks key shape, `_forkicks.py:130`), decision must be `requested` (a policy-autonomous start is refused for third-party apps: `mini-apps-approval.js:193` already does this for forkicks), `wait`, `start` with `authorization: grant`, then send `{draftId, approval: {taskId, payloadHash, payload}}` to the app.
4. The app server calls the cp `POST /tenants/:id/mini-apps/approval`. The cp's `request()` accepts any `(appId, operation)` whose catalog op is `needs-card`, checks the preview against the op's `returns` schema and `previewMaxBytes`, renders the summary from the same template, and then runs today's `authorized()` unchanged: a `human:resident` grant from the Telegram owner, the start bound to the grant, `requested.payload.summary === summary` (`mini-apps-approval.js:204-211`), binding and generation unchanged after (:402-408).
5. The app executes the target once under the lease, stores the receipt, returns it. Same-draft retries replay the receipt (app#377 review, round 2).

The resident's existing setting "Act through an installed app" (`approval-settings.js:134`, ask/never) governs every third-party card. No new settings row, no autonomous member row for any third-party app (contextsling plan review M1(b) and S6; the Gold Stars member row stays the one exception).

### 3.2 The summary template grammar (deterministic across Node and Python)

The card text is the only thing the cp and the overlay must agree on byte for byte, and today it is two hand-written functions (`forkicksSummary` in JS, `approval_summary` in Python). v2 replaces both with one tiny grammar, implemented once in each language with shared test vectors in the catalog repo:

- A template is a list of lines. A line is literal text with `{{path}}` substitutions and at most one `{{#each path}}...{{/each}}` block (one line per element, joined by `\n`).
- `path` is a dotted JSON path under `preview`; the value must be a string (rendered as JSON-escaped text as today's `text()` does, `mini-apps-approval.js:36-39`), a safe non-negative integer (as `money()` :40-43), or a boolean; anything else (an object, an array outside `each`, a float, a missing key) makes the render **fail**, which fails the card. No formatting functions, no conditionals beyond `{{#if path}}line{{/if}}` for optional keys (For Kicks' `note`).
- Output is escaped as today (`&`, `<`, `>`) and bounded by `summaryMaxBytes`.
- The conformance suite (§5.3) renders the template over the developer's fixture previews and over fuzzed previews, and compares the JS and Python renders byte for byte.

Every `preview` key must be shown by the template or named in `returns.bind` (so nothing hashed can change what the card describes without showing it: review finding S1 on cp#286, `mini-apps-approval.js:68-72`). The bot checks this statically (§6).

### 3.3 What is not generic

The Gold Stars send keeps its member class and its policy-start path in code; the resident-facing behaviour is Carter's ruling, not a platform rule. Everything else that pays, sends, publishes or shares a name with a third party is `needs-card` under the parent class. `write`-class ops never get a card (a standing ruling: no new consent gates); the bot's job is to stop a developer classing a spend as a `write`.

## 4. Skills delivered at install time from the catalog

Today: the box copies `skills/<id>/SKILL.md` from its own overlay checkout `$HOME/.hermes/edge-src` (`mini-apps-runtime.js:50`, `install_miniapps.ts:91`), so a one-word skill fix ships with the next fleet roll (skills#18 is still OPEN while its app is live, because the roll train is full).

v2:
- The projection names each skill with `version` and `sha256`. The installer fetches `GET <cp>/mini-apps/skills/<id>/<version>` (cp API key already on the box's edge-src sync path; the cp serves the bytes from the validated catalog), verifies the sha256 before writing, writes atomically as today (`install_miniapps.ts:81-90`), and records `{path, sha256}` in the receipt (:108). A hash mismatch fails the stage closed (no file written, intent kept, `mini_apps_unreviewed_bundle` code), exactly today's refusal shape.
- A skill change is then a manifest patch bump + a cp catalog reload; the cp's reconcile worker re-stages the installed rows (`mini-apps.js` drift re-stage, cp#244) and the agent reloads the plugin as it does after an install. No roll.
- The baseline skills the installer ships to every box (`gold-stars`, `skills/README.md` "gold-stars is also a baseline skill") stay in the overlay; the installer never removes a shipped skill (today's rule). Only app skills move to the catalog.
- Still a roll: anything under `plugins/`, `install/`, `skills/` that is not an app skill, AGENTS.md, the approval template (`approval-template-mirror.test.ts`).

## 5. Self-serve lanes

| Lane | Who sees the app | How a change goes live | Who looks |
|---|---|---|---|
| **sandbox** | the developer's own tenant(s) (allowlist entry for that id, as `restricted` works today) | Phase 0: a manifest PR merged by the developer + cp catalog reload. Phase 2: `POST /mini-apps/manifests/:id` with the owner token, no PR | nobody; the cp validator and the box's ceilings are the only guard; the data can only reach the developer's own agent |
| **admins** | every admin tenant | PR to the catalog repo touching only `mini-apps/<id>/**` and `skills/<id>/**`; CI green (schema, hashes, secrets scan); CONFORMANCE suite result attached (§5.3); the PR-review bot's verdict `PASS` (§6); auto-merge; cp reload | no human. The bot is the reviewer. Admins are staff who accepted to be the test cohort (by role) |
| **everyone** | every live resident | the same PR plus one human read of **only** the manifest diff and the conformance + bot output (not the developer's code, which never enters our repos) | one human (the platform lead or Carter), target under 15 minutes |
| **core** | n/a | today's gate: owner read + independent refutation + a recorded merge gate + the platform lead merges | the bridge itself (`plugins/village-bridge`, `village-bridge/*`), approval binding (`mini-apps-approval.js`, the shim, templates), payments logic (the lease), consent, the cp catalog loader, the manifest schema |

Rules that make the lanes safe without a human:
- A manifest PR may touch only its own `mini-apps/<id>/` and `skills/<id>/` paths; anything else is `core` and the bot answers `NEEDS_HUMAN` (CODEOWNERS-free, since all of the platform team's commits land under one GitHub account).
- Visibility can only be raised one step per PR (`sandbox -> admins -> everyone`), never in the same PR as a major bump.
- A `needs-card` op, an `oauth` auth block, a `data.context.ceiling` above `private`, or an `events` block entering the `everyone` lane always needs the human read (§6 "what still needs a human").
- Rollback is a manifest revert PR under the same lane rules; the cp also keeps the previous validated version and the platform lead can pin `MINI_APPS_PINNED[id]=<version>` by env var if an app misbehaves.

### 5.3 CONFORMANCE suite (the developer runs it; CI runs it again on the PR)

`bun run conformance -- mini-apps/<id>/manifest.json --base-url <staging>` (lives in the catalog repo; no Agent Village credentials needed):
1. Manifest validates against the v2 schema; every `skills[].sha256` matches the file; the version bump matches the diff class.
2. Service reachability: for `mcp`, `initialize` answers protocol `2025-06-18` and `tools/list` contains every `target.tool`; each tool's advertised `inputSchema` is a superset-compatible of the manifest's `input` (the manifest may be stricter, never looser). For `https-json`, every `target.path` answers a 2xx or a documented 4xx on the fixture. For `oauth`, discovery returns 200 and the resource answers 401 without a token (zzz design §3 step 2).
3. Budgets: every `read` op answers the fixture within `timeoutMs` and under `maxResponseBytes`; an oversize fixture is refused by the suite's own reader (so the developer sees what the resident's agent would see).
4. Approval: for each `prepare`/`needs-card` pair, the fixture's prepare returns a preview that renders under the summary template in both renderers byte for byte, within `summaryMaxBytes`, with every preview key shown or bound; a confirm with a wrong `draftId`, a changed hash or no grant is refused by the suite's fake cp; two confirms with the same `draftId` yield one target call (idempotency; S1 on app#377 "The merchant's idempotency ... is load-bearing").
5. Hygiene: no response contains a string matching the secret patterns; no response has duplicate JSON keys; error bodies are `{code, detail}` with a closed code.
6. Output: `conformance.json` `{manifest, sha256, results: [{check, pass, note}], passed: bool}` committed next to the manifest or attached to the PR; the bot reads it.

## 6. The PR-review bot (jmill's prototype, folded in)

Two halves. The deterministic half is plain CI that anyone can re-run; the LLM half is jmill's bot. The bot's verdict is a GitHub check on the catalog repo; the admins lane requires both checks green.

### 6.1 Deterministic CI (we write; runs in GitHub Actions on the catalog repo)
- Paths: changed files ⊆ `mini-apps/<id>/**` ∪ `skills/<id>/**` for one `id`; else `core`.
- Author: PR author ∈ `owner.github` of that manifest (or staff).
- Schema: v2 validation (the same module the cp uses, vendored), closed keys, URL rules, budget ceilings, op-name grammar, max counts.
- Hashes: `skills[].sha256` match; version bump class matches the diff (major for widened ops/budgets/auth/data/summary).
- Secrets: gitleaks-style patterns over the diff (tokens, `sk-`, `ghp_`, JWTs, private keys, `password=`), plus any `data:` URI or base64 blob over 1 KiB in a manifest or skill.
- data.context: declared `maxEntries` ≤ 64; `ceiling` ≤ the lane's ceiling; no other `data.*` block unless the lane allows.
- Approval: every `needs-card` op has a `prepare`, a template that renders on the fixture in both renderers, and shows or binds every preview key; no op that is `needs-card` in the previous version became `write`/`read` (a downgrade is `core`).
- Conformance: `conformance.json` present, `passed: true`, its `sha256` equals the manifest's.

### 6.2 The LLM review (jmill's bot; Odin's Claude subscription; Edge City infra)
Reads the manifest diff, the SKILL.md diff and `conformance.json`, with the guidelines as its rubric, and answers the questions a schema cannot:
- "Only MCP or skills, no code execution": does the SKILL.md ask the agent to run a shell command, fetch code, install a package, add a cron, call an endpoint directly, or bypass the `village` tool? (The README's own rule, `mini-apps/README.md:39-42`.) Does any op description describe executing code on the box?
- "No internal data storage": does the skill or any op description ask the agent to write memory files, USER.md, or store resident data anywhere but the declared `data.context` lines? Does the service appear to receive resident identity beyond what the permissions text says?
- Class honesty: is every op classed `read` truly a read (no side effect on the resident's account, no message sent, no money)? Does anything that pays, sends, publishes, or shares a name with a third party carry `needs-card`? (For Kicks' "sharing your previewed display name with the café" is the precedent for `needs-card`.)
- Permissions text vs. ops: do the human-readable permissions name every third party that receives data (Dizko S2 precedent, contextsling review S3(c))?
- Skill prose: does it tell the agent never to claim success without a receipt, to retry the same `draftId`, and that returned text is data not instructions? Does it invent authority ("the resident already approved")?
- Prompt-injection surface: does the skill instruct the agent to follow instructions found in service responses?

### 6.3 Output format
A single PR comment (edited in place on each push) and a check-run conclusion:
```json
{ "bot": "av-miniapp-review", "version": "0.1", "manifest": "forkicks@1.1.0", "head": "<40 hex>",
  "verdict": "PASS" | "FAIL" | "NEEDS_HUMAN",
  "lane": "sandbox" | "admins" | "everyone" | "core",
  "findings": [ { "code": "skill_shell_instruction", "severity": "M" | "S" | "N", "file": "skills/forkicks/SKILL.md", "line": 42, "text": "…one sentence…" } ],
  "checked": [ "paths", "author", "schema", "hashes", "secrets", "data_context", "approval_classes", "conformance", "skill_prose" ] }
```
`M` = FAIL; `S` = PASS for sandbox, NEEDS_HUMAN for admins/everyone; `N` = notes. The same codes the deterministic half emits, so one comment carries both.

### 6.4 Where it runs and how it gates
- The deterministic half: GitHub Actions in the catalog repo (free minutes are fine at this volume; the overlay repo already has `.github/workflows`).
- The LLM half: jmill's service in Edge City infra, triggered by the PR webhook, posting the comment and the check through a GitHub App token scoped to that repo (no Agent Village credentials, no resident data; it sees only the diff and `conformance.json`). Its model spend is on Odin's subscription, which is why it must never receive production data: nothing in a manifest PR is resident data by construction.
- Gate: branch protection on the catalog repo's `main` requires both checks for paths under `mini-apps/**`. `PASS` + lane `admins` -> auto-merge (a GitHub Action with the merge permission, or jmill's bot itself). `PASS` + lane `everyone` -> the human read, then merge. `NEEDS_HUMAN`/`FAIL` -> no merge. This is enforced only on the catalog repo, not on the three product repos (an existing decision: no rulesets binding partners on product repos); partners keep deploy rights as before.
- The bot is advisory on **our** PRs to core: it may comment, it never gates them.

### 6.5 What still needs a human
- The `everyone` lane (one diff read).
- Any `core` path.
- A new `service.auth.mode` for an app (first OAuth client registration: a human registers the client and sets the env vars; S4 of the contextsling review).
- The first `needs-card` op an app ever publishes (the human reads the card template once, on the sandbox fixture).
- Raising `data.context.ceiling` above `private` for an `everyone` app (§7).
- Any `events` block (a data release is a matter for the data team: the mini-apps data proposal, §2C).
- A bot `NEEDS_HUMAN`, and any bot `PASS` the platform lead chooses to spot-check (suggest 1 in 5 for the first month, each logged as a one-line read record).

## 7. App context: how the manifest carries the ceiling (recommendation, not a decision)

Open question for the context-store owner (a separate proposal on the app context model, not yet written when this design was drafted). Carter: apps should set each line's public/village/private section, capped by a per-app ceiling the resident sets, and there was "a different folder layout for app context". Today: every app line is PRIVATE by construction (`context-app-namespaces.js:113-125`), the section is derived from scopes (`:75-80`), only the resident widens on the Context page.

Recommendation for the manifest side (the context-store owner owns the cp/app/box side):
- `data.context.ceiling` in the manifest is the app's **requested** maximum (`private` | `village` | `public`), reviewed at catalog time. It is a declaration of intent the resident can read on the install card ("This app may suggest lines for your Village section").
- The resident's ceiling lives in `tenant_mini_apps.desired[appId]` next to the version: `{ version, contextCeiling }`, set on the install card (default `private`) and changeable in the Mini-apps sheet. Effective ceiling = min(app requested, resident chosen).
- The write body grows one optional field per line: `{ text, section? }`. The cp clamps `section` to the effective ceiling (`insertScopes` becomes "the app's requested section, narrowed to the ceiling, never wider than an existing resident override": the fix direction of review finding M1 on cp#314). A line the resident moved keeps the resident's section; a line the resident deleted stays suppressed; a replace never widens.
- Box layout: render each app's lines under `knowledge/agentvillage/apps/<appId>/` with one file per effective section (`public.md`, `village.md`, `private.md`), and keep the `_profile.md` section (`appHeadingOf`, `:262`) for the private lines only; the group/cron reduced block then includes the app's public+village files and never the private one. This is a recommendation to the context-store owner, not a decision; their fact-find may surface the earlier layout Carter remembers.
- The bot checks: `ceiling` present when `data.context` is, `ceiling` ≤ lane ceiling, and the skill never tells the agent to "save as public" without the resident asking.

## 8. Phased plan, migration, risks, questions

### Phase 0 (this week; no fleet roll; nothing resident-visible)
1. **Manifest v2 JSON Schema + validator** as one module shared by the cp (`control-plane/src/mini-apps-manifests.js`), the app (vendored for `catalog.ts`) and CI. Convert the five catalog constants to five `manifest.json` files in the overlay repo (they already exist in v1 form) and have the cp load them at boot behind `MINI_APPS_MANIFESTS=1`, serving today's exact projections (golden test: byte-equal `APPS`/`NEWEST_APPS`). Size: cp 1 module + 5 JSON + tests.
2. **Budgets from data**: app `http.ts` `FRAMED_WRITES` and the overlay `transport()` tables read from the catalog op records (the catalog carries `maxRequestBytes`/`timeoutMs` per op already in Phase 0; the overlay keeps its constants until the roll). App only.
3. **Bot v0**: the deterministic CI (§6.1) on the overlay repo for `mini-apps/**` + `skills/**` paths; jmill's LLM half posts its comment on the same PRs. Verdict not yet required. Share the dev summary with jmill; agree the JSON output (§6.3).
4. **Sandbox lane** = today's `restricted` + allowlist entry for the developer's tenant, documented in the dev summary. Already works for zzz/Slopfolio.
5. **Conformance v0**: the manifest/hash/secrets/renderer checks (§5.3 items 1, 4-template, 5) as a bun script in the catalog repo; service checks (2-3) in Phase 1.

### Phase 1 (next two weeks)
6. **Generic approval card**: cp `request()` accepts any catalog `needs-card` op + the template renderer (JS) with shared vectors; overlay `authorize_action` + the Python renderer; app `mini_app_drafts` table + lease; For Kicks and the Gold Stars parent path move onto it (legacy keys still accepted for one train). Core lane, full gate.
7. **Generic OAuth + grants table** + the `[appId]` connect routes; zzz and Slopfolio move on next reconnect.
8. **Generic app dispatcher** in `runTool` for manifest ops; delete `mini-apps/zzzbot/operations.ts`-style per-app modules as each app flips.
9. **Conformance v1** (service checks) and the bot verdict becomes **required** for the admins lane on the catalog repo.

### Phase 2 (after the next rc train)
10. **Signed projection + schema-from-projection** in the overlay (§2.2); the cp serves v2 projections to qualifying boxes; the exact-equality constants and the floor-tag variants retire one train later.
11. **Skills from the catalog** (§4): cp skill route + installer fetch + hash check.
12. **Manifest push route** for the sandbox lane (`POST /mini-apps/manifests/:id`, owner token).

### Phase 3
13. **Everyone lane** live with the 15-minute human read; `data.state`/`events` blocks per the mini-apps data proposal once data has the door contract.

### Risks
- **The overlay roll is the long pole.** Every box-side change (Phase 2) rides a release train that is already full (v2.1.2/v2.1.3), and an older box refuses an unknown projection and loses Gold Stars with it (`mini-apps-catalog.js:73-78`). Mitigation: dual acceptance for one train, cp floor-tag gating as today, and Phase 0-1 need no roll at all.
- **Two renderers, one card.** The template grammar is tiny on purpose; the shared vectors and the conformance byte-compare are the guard. A render difference fails closed (the cp refuses the proof), never open.
- **The LLM half is confidently wrong sometimes.** It never gates alone: the deterministic checks and the conformance result gate; the LLM adds `NEEDS_HUMAN`, and the everyone lane keeps a human. Spot-check PASSes.
- **Faster also means a typo goes live faster** (admins lane). Bounded by: admins only, the cp's hard ceilings, instant env pin/rollback, and nothing in a manifest can execute code.
- **Secret custody moves to convention** (`secretRef`, `MINI_APP_<ID>_OAUTH_CLIENT_ID`). A human still sets every variable; the bot refuses any literal.
- **One token key for all grants** is a bigger blast radius than per-app keys; keep per-app keys if Carter prefers (the default keeps one key, rotated never once residents connect, as today's rule).
- **Core ops and the first-party manifest**: making gold-stars "a manifest" must not loosen its member-class path; the manifest for `internal` kind carries no target and the handlers stay in code.
- **Research/data**: manifests with `events` need the data door; not in Phase 0-2.

### Questions for Carter (each with a default) (answered: defaults)
1. **Admins lane with no human at all?** A manifest PR with CI green + conformance green + bot PASS auto-merges and goes live for admins (staff) without anyone of ours reading it. Default: **yes** (that is the SPOF jmill means; admins are the test cohort by role).
2. **Where do manifests and skills live?** (a) stay in the overlay repo `mini-apps/` + `skills/` (Phase 0 default, zero moves), or (b) a new small repo `Edge-City/agentvillage-mini-apps` that the cp pins by tag, so partner PRs never touch the overlay. Default: **(a) now, (b) in Phase 2** when the cp fetches manifests itself.
3. **Third-party needs-card default**: parent class `marketplace.app.action` at "ask", no autonomous member rows for any third-party app (Gold Stars stays the one exception). Default: **yes** (same as the contextsling review's M1/S6).
4. **App-context ceiling default**: resident ceiling defaults to `private` at install; the app may request up to its manifest `ceiling`; the resident raises it on the install card or in settings. Default: **private**, pending the context-store owner's proposal.
5. **Who presses the bot's merge?** jmill's bot (a GitHub App with merge rights on the catalog repo only) or a GitHub Action we own. Default: **our Action merges on both checks green**; jmill's bot comments and sets its check. Keeps merge authority in a repo we administer.
6. **Everyone lane reviewer**: the platform lead or Carter only. Default: **the platform lead**, with a one-line read record per read; Carter only for the first `needs-card` op of a new app and for `public` context ceilings.

Not Carter's: the template grammar, the table names, the env naming convention, the conformance check list, the phase order inside Phase 1.
