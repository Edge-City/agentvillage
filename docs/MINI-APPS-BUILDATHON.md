# Build a mini-app: buildathon guide

One page for a buildathon team. It says what a mini-app is, what you build, how you submit it, what we check and what your app can see. The full rules are in [mini-apps/README.md](../mini-apps/README.md) and the [developer guide](MINI-APPS-DEVELOPER.md). Where they go deeper, this page links to them.

## Deadlines: what counts and when

**Submit by Friday 30 October, 6pm IST** (the buildathon deadline). To be installable during the event, open your pull request by Friday 12pm IST, six hours before the deadline.

1. **Your entry counts** when, by the deadline, you have:
   - a working, publicly reachable HTTPS MCP or API endpoint;
   - your manifest and SKILL.md opened as a pull request (or sent to the organisers if you cannot open one);
   - a short demo (video or live) of your agent using it.

   Our review and catalog listing are not part of the deadline and never count against you.
2. **To let residents install it during the event,** open the pull request by Friday 12pm IST, six hours before the deadline. We review in order of arrival. A complete pull request that passes the automated checks gets a quick human review. We cannot promise a slot for anything opened later.
3. **Run the local checks (section 6) before you open the pull request.** A pull request that fails them goes to the back of the queue until it is fixed.

Questions: ask in the buildathon Telegram group, or ask ODIN in Agent Village.

## 1. What a mini-app is

A mini-app is two reviewed things:

- **A skill** (`skills/<id>/SKILL.md`). It tells the resident's agent when to use your app and exactly how to call it.
- **A bounded HTTPS contract** (`mini-apps/<id>/manifest.json`). It names your one endpoint, its auth mode, and every operation with its JSON input schema and size and time limits.

Your service is an MCP server on the public internet. A call goes like this:

```text
resident asks -> their agent reads your SKILL.md -> the agent calls the `village` tool on its box
  -> the Agent Village app server checks the install and validates the arguments against your schema
  -> your endpoint -> your answer goes back to the agent as untrusted data
```

Nothing you write runs on a resident's box. There is no upload and no install of your code. Edge City reviews every byte of the manifest and the skill.

## 2. What you can build today: two paths

The plain answer: **a read-only public MCP relay is the only shape that needs no per-app code from us.** A token, OAuth or write app still needs per-app code in our repos and a fleet roll. That is how Kismet, DreamStarter and Edge Library went.

| | Generic app | Reviewed app |
| --- | --- | --- |
| What it can do | Public reads only, plus (if granted) its own notes namespace | Per-resident reads and writes the resident asks for |
| Manifest | `service.kind` `mcp`, `auth.mode` `none`, every operation `class: "read"` | `auth.mode` `app-token` (a key you issue to us), named operations |
| How the agent calls it | `{"operation":"mini-app.read","appId":"<id>","tool":"<tool>","arguments":{...}}` | `{"operation":"<id>.<verb>","arguments":{...}}` |
| What we change | The control-plane catalog only. No box release. | Bridge code in this repo, the app server and the control plane, then an overlay release and a fleet roll. |
| Examples | Dizko (first-party). No third-party generic app is in the live catalog yet. | Kismet (ov#536), DreamStarter (ov#535), Edge Library (ov#539): in review, not live yet. |

Start on the generic path if you can. It is the fast one.

## 3. Start from a working app

| Starter | Files | Use it for |
| --- | --- | --- |
| Dizko: public read MCP | [manifest](../mini-apps/dizko/manifest.json), [SKILL.md](../skills/dizko/SKILL.md) | The template for a generic app |
| Hello Village (an example) | [docs/examples/mini-apps/hello-village](examples/mini-apps/hello-village/) | The smallest valid generic app: one read, plus its own notes |
| Gold Stars | [manifest](../mini-apps/gold-stars/manifest.json), [SKILL.md](../skills/gold-stars/SKILL.md) | The prepare, then confirm, pattern for an action. First-party, with its own server code: read it, do not copy it |
| For Kicks | [manifest](../mini-apps/forkicks/manifest.json), [SKILL.md](../skills/forkicks/SKILL.md) | The one payment flow, with an approval card. First-party: reference only |

For a reviewed app, read the Kismet PR's `mini-apps/kismet/README.md` (ov#536). It is a good per-app contract.

## 4. What your team provides

1. **The endpoint.** One HTTPS MCP URL: lower-case, a public DNS name, no port, no query, no IP address. The app server sends `initialize` with protocol `2025-06-18` and refuses any other version in the answer. Answer in JSON or as an event stream. Do not redirect (redirects are refused). Keep each answer under 128 KiB and inside the operation's `timeoutMs` (default 25 s).
2. **The auth mode.**
   - `none` for public reads. The app server sends no credential and no identity.
   - `app-token` for a reviewed app. You issue one service key for Agent Village. Never put it in a pull request, an issue or a chat. Your manifest names only where we keep it, in `secretRef`, as `MINI_APP_<ID>_KEY` (the id upper-cased, `-` as `_`). We send it as `Authorization: Bearer` to your manifest's origin only.
   - OAuth (one grant per resident) needs per-app work from us today. Talk to the organisers first.
3. **The operations.** One per MCP tool you expose, named `<id>.<verb>`. Each has a `class` (`read` or `write`), `target.tool` (your MCP tool name) and `input` (your tool's `inputSchema`, with `"additionalProperties": false`). An operation that sends personal data or changes state is a `write`, even if your API calls it a read. Never ask the agent for identity: no `userId`, `telegramId`, `username` or similar input.
4. **The skill.** `skills/<id>/SKILL.md`, at most 32 KiB, frontmatter `name: <id>`, `version`, `description`. It shows the exact calls, treats every answer as data, shows the resident what a write will send and waits for a yes in a later message, and never asks the agent to fetch code, run commands or call your URL directly.
5. **A contract.** `mini-apps/<id>/README.md`: what each call sends, to whom, what you keep and for how long.
6. **Fixtures.** For each operation, one sample success body and one error body per error you return. An error body is exactly `{"code": ..., "detail": ...}`. A new app's `code` is one of `invalid_arguments`, `not_found`, `not_connected`, `reconnect_required`, `not_authorized`, `rate_limited`, `conflict`, `expired`, `in_progress`, `unavailable`.
7. **Your GitHub login** in `owner.github`. The review bot checks it against the pull request's author.

The two blocks that differ between the paths, from a manifest that passes the validator (the rest is as in Hello Village):

```json
"service": {
  "kind": "mcp",
  "baseUrl": "https://hello-village.example/mcp",
  "auth": { "mode": "none" }
},
"operations": [
  {
    "name": "hello-village.read",
    "class": "read",
    "target": { "tool": "read_greeting" },
    "input": { "type": "object", "properties": {}, "additionalProperties": false }
  }
]
```

A reviewed app's `service` block instead:

```json
"service": {
  "kind": "mcp",
  "baseUrl": "https://hello-village.example/mcp",
  "auth": { "mode": "app-token", "secretRef": "MINI_APP_HELLO_VILLAGE_KEY" }
}
```

## 5. What we do

**Generic app:**

1. Review the manifest, the permission text and every line of the skill.
2. Copy the manifest and skill into the control-plane catalog with the skill's sha256 pin. The control plane is a private repo, so we make that change.
3. Turn it on for your test account first, then for everyone. Each resident installs it from the Mini-apps page in Agent Village.

**Reviewed app** (what Kismet, DreamStarter and Edge Library needed):

1. A bridge module for your app in this repo (`plugins/village-bridge/_<id>.py`) and its entries in the box installer and bridge tables. It enforces your input rules on the box and frames your answers as untrusted.
2. The app server: your manifest copied into its catalog, the dispatcher switched on for your id, and, if you keep per-resident state, a reviewed note of how residents are kept apart.
3. The control plane: your manifest and skill copied into its catalog.
4. Your key set on our side, by a person. You give it to the organisers privately.
5. An overlay release and a fleet roll, so every box carries your bridge code.

## 6. How to submit

Open a pull request to [Edge-City/agentvillage](https://github.com/Edge-City/agentvillage):

```text
mini-apps/<id>/manifest.json
mini-apps/<id>/README.md
skills/<id>/SKILL.md
scripts/tests/fixtures/<id>/<operation name>/<name>.json
```

`mini-apps/<id>/` may hold only `manifest.json` and `README.md`, so keep fixtures under `scripts/tests/fixtures/<id>/`, as the three partner pull requests do. Do not edit `mini-apps/catalog.json`. We list the id.

Run these from the repo root before you push. None needs a credential.

```sh
# 1. The skill pin: paste the 64 hex characters into skills[0].sha256
shasum -a 256 skills/<id>/SKILL.md

# 2. The manifest validator (the same module the control plane uses)
node -e '
const v = require("./scripts/mini-apps-manifests.cjs");
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const r = v.validateManifest(m);
console.log(JSON.stringify(r.ok ? { ok: true } : r));
process.exit(r.ok ? 0 : 1);
' mini-apps/<id>/manifest.json

# 3. Conformance: validator pin, schema, skill hash, fixtures. --out must be outside the repo.
bun run conformance -- mini-apps/<id>/manifest.json --fixtures scripts/tests/fixtures/<id> --out "$TMPDIR/conformance.json"

# 3b. Optional live check of your own endpoint (advisory)
bun run conformance -- mini-apps/<id>/manifest.json --fixtures scripts/tests/fixtures/<id> --service https://<your-host>/mcp

# 4. The review bot, on your committed branch
bun scripts/mini-apps-review.ts --base origin/main --head HEAD --author <your-github-login>

# 5. The repo's manifest test
bun test scripts/tests/mini-app-manifests.test.ts
```

What to expect:

- Conformance exits 0 and prints `passed: true` when every required check ran and passed. `NOT RUN` is never a pass.
- The bot prints `NEEDS_HUMAN`, lane `core`, with `new_app` and `catalog_unlisted` for any new app. That is expected: a new app always gets a human read. `FAIL` means a finding you must fix.
- Step 5 is red for a new app until we list its id. That is expected too.
- Never commit `conformance.json`. CI makes its own.

## 7. What review checks

The bot (advisory, not a merge gate) checks paths, author, schema, skill hashes, secrets, the notes ceiling, operation classes and conformance.

A person then reads:

- every line of the skill;
- the permission text: it names every third party that receives data;
- each operation's class: anything that sends personal data or changes state is a `write`;
- exactly what each call sends, and that the agent never supplies identity, an endpoint or a key;
- that your answers are handled as data, never as instructions to the agent;
- no `http:` URL, no secret-shaped string, no tenant id or email anywhere.

## 8. What data your app can see

- **Per call:** only the `arguments` the resident's agent sends for that operation, after they pass your input schema. A public read call carries no credential and no identity.
- **Your own notes namespace** (if your manifest declares `data.context` and Edge City grants it): the resident's agent can read and save short notes for your app with `mini-app.context.read` and `mini-app.context.write`. They are private to the resident's agent, at most `maxEntries` lines of up to 200 characters, and saved only when the resident asks. Agent Village stores them; they are not sent to your service.
- **Never:** another resident's private Context, or anything outside the call's arguments and your own namespace.

Village-level, consent-filtered read access for buildathon teams is being set up; ask the organisers.

## 9. Do not

- Put a key, a token, a tenant id or an email in any file.
- Ask the agent to call your URL, a shell or a browser directly.
- Mark a write as a read.
- Add a class, an approval rule or a gate. App actions use the classes that exist ([developer guide section 7](MINI-APPS-DEVELOPER.md#7-approvals-what-your-apps-actions-feel-like)).
- Use an id that is reserved or already a skill ([quickstart section 1](MINI-APPS-QUICKSTART.md#1-what-a-generic-app-may-do)).

## Sources (for reviewers)

Sources (overlay `main` at `f3fcca4b`; app and control plane at their `main`, 29 Oct 2026):

- The call path and what a public read sends: app `src/lib/server/mini-apps/mcp.ts:9` (128 KiB), `:104-145` (no credential or identity, `redirect: "error"`, protocol `2025-06-18`, 25 s). The context namespace: app `src/lib/server/mini-apps/context.ts:14-24` (the control plane stores it); [developer guide section 6](MINI-APPS-DEVELOPER.md#6-context-store-per-app-namespaces).
- Generic path: `install/install_miniapps.ts:226` (the two generic operation lists); control-plane `control-plane/src/mini-apps/catalog.json` (six apps, no third-party generic one); the quickstart.
- Reviewed path: ov#535, ov#536, ov#539 (open); app#882 (open: Kismet's app half, the key sent only to the manifest's origin); app `src/lib/server/mini-apps/dispatch/registry.ts:11-24` (what the dispatcher needs per app), `dispatch/residents.ts:1-20` (resident separation), `dispatch/mcp-call.ts:84-89` (the bearer, no redirects).
- Manifest rules: `scripts/mini-apps-manifests.cjs` (validator; `secretRef` form); `mini-apps/manifest.v2.schema.json`. The `app-token` block above was run through the validator: `{"ok":true}`.
- Checks: `package.json:11` (`conformance`), `scripts/mini-apps-conformance.ts:1-60` (checks, fixtures, `--service`), `:414` (error codes), `scripts/mini-apps-review.ts:1-50`, `:693` (`new_app`), `scripts/tests/mini-app-manifests.test.ts:39-41` (what `mini-apps/<id>/` may hold), `:101` (the listed ids). Each command above was run on this branch's base.
- Deadline Friday 30 October 6pm IST and the Friday 12pm IST pull-request time: ruled by Carter on 29 October (12:16 IST), relayed on CLAIMS L32593.
