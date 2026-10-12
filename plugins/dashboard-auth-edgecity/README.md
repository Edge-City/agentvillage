# dashboard-auth-edgecity

Hermes dashboard auth for Edge City tenants. It registers three things with Hermes:

| Provider | Kind | Who uses it |
|---|---|---|
| `edgecity` | interactive session (password form) | the tenant's owner: email, then a one-time code sent by the control plane; landing admins through `/admin/dashboard-sso` |
| `edgecity-archive` | token only, never offered at login | the archive job (DATA-66), with the tenant's `archive_read` bearer (DATA-88) |
| a route wrapper around Hermes's token seam | middleware | scopes the `archive_read` bearer to two routes |
| the resident guard: wrappers around Hermes's cookie gate, socket tickets, socket auth and chat gateway | middleware | residents get a named set of dashboard features, landing admins get all (SEC-1) |

The owner flow is described in `docs/deployment.md` ("Edge City authentication and local
verification"). This README covers the `archive_read` bearer and the resident guard.

## The archive_read bearer

### What it can read

Exactly two routes, `GET` only:

| Route | Returns |
|---|---|
| `GET /api/sessions` | the session list: ids, titles, sources, counts, previews. With `full=1` each row also carries the system prompt and model config. |
| `GET /api/sessions/<id>/messages` | **full message bodies** of that session, paged (Hermes caps a page at 500). |

The query string is Hermes's (`limit`, `offset`, `order`, `profile`, …) and is not matched, so the
token reads every profile's sessions in that sandbox through `profile=`. Hermes's `GET
/api/sessions` also runs its own auto-archive maintenance before listing, as it does for any reader.

`<id>` must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Matching is exact on both the parsed URL
path and the ASGI scope path, with no normalisation: a trailing slash, `//`, `..`, a
percent-encoded `?`, `#`, `/` or control character, or any other method (`HEAD`, `OPTIONS`,
`POST`, `PATCH`, `DELETE`, …) is not one of the two routes. Everything else — every other
session route (`search`, `stats`, `export`, `timeline`, `messages/around`, `DELETE`, `PATCH`),
`/api/cron/jobs` (job prompts, and its path is shared with a `POST`), config, env — refuses the
token.

### How it is verified

The control plane derives the tenant's token from one master and writes only its SHA-256 into
the sandbox (DATA-88 lane 88b):

```
token  = hex(HMAC-SHA256(key = ARCHIVE_READ_MASTER as set, msg = "archive_read:" + tenant_id))
stored = hex(SHA-256(token))          # AV_ARCHIVE_READ_HASH in $HERMES_HOME/.env
```

`tests/vectors/archive_read.v1.json` at the repository root pins the derivation with test keys;
the control plane and `agentvillage-data` copy it verbatim.

- The sandbox holds the hash, never the token or the master, so it can verify its own tenant's
  token and nothing else. Tenant B's token is refused on tenant A.
- `AV_ARCHIVE_READ_HASH` is re-read from `$HERMES_HOME/.env` once per request that presents a
  bearer on one of the two routes (`GET` only), so a re-injected hash takes effect on the next
  request with no restart. **The file is authoritative whenever it exists**: Hermes copies `.env`
  into the process environment once at startup, so the environment holds the pre-rotation value.
  The environment answers only when there is no `.env` at all, and only with exactly 64 lowercase
  hex characters.
- Only the exact line the control plane writes counts: `^AV_ARCHIVE_READ_HASH=([0-9a-f]{64})\r?$`
  — no `export`, quotes, whitespace, comment or BOM. Any other line is not a hash line (it neither
  sets nor clears the hash), and the last exact line wins. No exact line, or an unreadable file,
  means the archive token is accepted nowhere.
- `HERMES_HOME` itself is read per request, so while Hermes's profile-delete cleanup has it
  pointed elsewhere an archive request may find no hash and be refused (transient, fail closed).
- **Single-user exposure, accepted.** The sandbox runs as one user, and that user (the agent
  included) can write `$HERMES_HOME/.env`, so it could replace the line with the hash of a token
  of its own choosing. That is the same single-user exposure as the consent allowlist (DATA-234),
  and it is accepted until the checkpoint rebuild gives the hash a file the agent cannot write.
  What it exposes is a read credential to that tenant's own transcripts only: the hash never
  verifies another tenant's token and grants nothing beyond the two routes.
- The compare is `hmac.compare_digest` on the two hex digests.
- When the archive provider vouches for a bearer on one of the two routes, its principal
  (`archive-read`, provider `edgecity-archive`, scope `archive_read`) sets
  `request.state.token_principal` and `request.state.token_authenticated` exactly as Hermes's seam
  does, and the cookie gate then lets it through.
- Any other bearer on those routes (another tenant's token, a stale token after rotation, any
  bearer while the hash is unset or the provider is missing) **falls through** to Hermes's seam
  and cookie gate exactly as if the plugin were absent. A Hermes session bearer (the desktop app's
  native path) is served as before; anything else ends in the gate's own 401
  (`reason: invalid_or_expired_session`).

### Why a wrapper, and what never accepts it

Hermes's token seam (`hermes_cli.dashboard_auth.token_auth.token_auth_middleware`) authenticates
only paths registered with `register_token_route`, by exact path, any method. Registering
`/api/sessions` would send every request on it, cookie users on the dashboard's Sessions page
included, through the token check and 401 them. So the plugin wraps the seam at `register()`
time (`web_server._token_auth_seam` imports `token_auth_middleware` at call time, so the wrapper
takes on the next request) and handles a request only when it is a `GET`, carries a bearer, and is
one of the two routes. Every other request goes to the original seam untouched.

- **`verify_session` never accepts the token.** A provider's `verify_session` is never told the
  path, so it could not scope it. `edgecity-archive` has `supports_session = False` (not listed at
  login, never asked to verify a cookie or a session bearer) and its `verify_session` returns
  `None`; `edgecity`'s `verify_session` only accepts its own signed sessions.
- **`verify_token` answers only inside the wrapper.** Hermes's seam asks every token provider
  about a bearer on any registered token route (the drain plugin registers
  `/api/gateway/drain`). `edgecity-archive.verify_token` returns `None` unless the wrapper is
  deciding one of the two routes, so the token never authenticates another token route.
- **No registered provider, no access.** The wrapper asks Hermes's registry for
  `edgecity-archive` on every request; if it is not registered (the plugin failed to load, Hermes
  ignored the registration, it was unregistered) the bearer falls through and the archive token
  is accepted nowhere.
- **One wrapper, agreeing with whichever provider is registered.** The "inside the wrapper"
  flag lives on the provider instance, and the wrapper sets it on the instance it looked up, so a
  second load of the plugin under another module name cannot split them. A load whose
  registration Hermes ignored (a non-launch profile scope) does not touch the installed wrapper;
  a launch-scope re-discovery replaces both provider and wrapper (one layer, never stacked).
- **Falling through never widens anything.** The provider vouches only inside the wrapper's
  decision, so a bearer passed on reaches session providers (which do not know the archive token)
  and token routes (where the archive provider declines), never an archive-token acceptance.
- Cookie users and Hermes session bearers are unaffected: the wrapper only ever adds the archive
  token's acceptance on the two routes.

### Rotation (D4)

Rotate `ARCHIVE_READ_MASTER`, re-inject, no recreate. Order: set the new master on the control
plane, re-inject every live tenant's `AV_ARCHIVE_READ_HASH` (one `updateTenant` per tenant, or the
control plane's reinject script), then set the new master wherever the archive job runs. Between
the two steps the job's old tokens are refused (`dashboard_unauthorized`) and it retries on its
next run; the old token is refused on the first request after its tenant's `.env` changes.

### Limits

- No rate limit on the bearer routes; Hermes has none on token routes either. Accepted: the token
  is 256 bits.
- `.env` is read without a lock. A reader that catches the control plane mid-write sees no valid
  line, so that one request falls through and the archive token gets the gate's 401 (fail closed).
- Logs go to `dashboard-auth-edgecity.archive` and carry a code and running counts, never the
  token, its hash or the path: `accepted` at INFO; the pass-through codes (`passed_not_archive`,
  `passed_hash_unset`, `passed_no_provider`, bearers handed on to Hermes's seam) at DEBUG only, so
  a desktop app polling with its session bearer does not fill the log.
- Hermes below the control plane's minimum (v2026.9.21) is not special-cased. The seam this
  depends on was read at Hermes v2026.9.24 (0.21.5) and is byte-identical at 0.21.3.

## Resident guard (SEC-1)

Residents may not install plugins; admins may (Carter, 12 Oct 2026). The refuter showed that a
route list cannot hold that ruling: Hermes's dashboard is an operator console, and behind the
ordinary login it also writes `config.yaml` and `.env`, reads and writes any file the `hermes` user
can, arms shell hooks, opens a console and a terminal, and lets its chat socket install plugins and
run shell commands. So from 1.3.0 the dashboard is a closed allow-list: a session that is not a
landing admin may use the features named in one table, and nothing else.

### Who is admin

Exactly `session.provider == "edgecity" and session.org_id == "admin"`, both plain strings. The
`edgecity` provider mints `org_id = "admin"` only in `complete_login`, the landing-admin SSO
exchange with the control plane (`/dashboard-admin/exchange`); the owner's email-code login mints
`"owner"`. Everything else is a resident: no session, a token principal (the archive bearer, any
service bearer), a session from another provider, any other role, or an exception while deciding.

### What a resident keeps

The tables are at the top of `_resident_guard.py`, one row per capability with its reason:

- **Signing in and out**: `/login`, `/auth/*` (email code, landing-admin SSO, desktop sign-in,
  logout), `GET /api/auth/providers`, `GET /api/auth/me`, and `POST /api/auth/ws-ticket` (the
  ticket for the chat socket; it carries the role).
- **Hermes's public paths**, which are open to anyone without a session anyway: `/api/health`,
  `/api/status`, `/api/config/defaults`, `/api/config/schema`, `/api/model/info`,
  `/api/dashboard/themes`, `/api/dashboard/plugins`, `POST /api/cron/fire` (its own signed token) and
  the MCP OAuth callback.
- **The page shell**: every dashboard page (the SPA index), the bundle, fonts and icons, enabled
  dashboard plugins' static files, `GET /api/profiles`, `GET /api/profiles/active`,
  `GET /api/dashboard/font`.
- **Their own sessions** (one tenant per box): list, search, stats, read, timeline, export,
  rename, delete, bulk delete, delete empty, prune.
- **The web chat's uploads**: `POST /api/chat/image-upload`.
- **The approvals card**: `/api/plugins/av-approval/**`, reserved for av-approval's own dashboard
  routes. None is mounted at this version.
- **Sockets**: only the chat gateway, `/api/ws`.
- **Chat gateway methods** on `/api/ws`: handshake (`ping`, `gateway.capabilities`,
  `client.capabilities`), chats (`session.create`, `.resume`, `.list`, `.most_recent`, `.title`,
  `.close`, `.delete`, `.interrupt`, `.events.since`), `prompt.submit`, answering the agent
  (`approval.pending`, `approval.received`, `approval.respond` with `once`, `session` or `deny`
  but never `always`, which writes `config.yaml`; `request.answer`), uploads (`image.attach_bytes`,
  `image.detach`, `file.attach` and `pdf.attach` with bytes only, never a host path) and
  `model.options`.

### What is admin only

Everything else, including everything Hermes adds in a later version until someone lists it:
plugins (install, enable, disable, the hub), config and raw config, `.env` (read, write, reveal),
files and `/api/fs/*`, hooks, MCP servers, skills, cron, models and providers, credentials,
profiles (beyond the two reads), pairing, webhooks, messaging platforms, logs, analytics, gateway
start/stop/restart/update, Hermes update, backups and imports, git, local models, the Hermes
Console (`/api/console`), the terminal (`/api/pty`), the PTY's event feed (`/api/pub`,
`/api/events`), TTS streaming, the Bot Desktop bridge, dashboard plugins' own APIs (kanban), and
every gateway method not listed above (`shell.exec`, `cli.exec`, `plugins.manage`, `slash.exec`,
`command.dispatch`, `config.set`, `config.get`, ...).

At Hermes 0.21.5 the dashboard's Chat tab is the terminal: it runs `hermes --tui` behind
`/api/pty`, and that TUI drives the gateway with the server's own credential. So **a resident has no
Chat tab on the dashboard**; the gateway chat methods above serve a chat client that speaks to
`/api/ws` directly (the desktop app). Residents chat with their agent on Telegram as before.

### What a resident sees

- A route off the list answers `403`
  `{"error": "forbidden", "detail": "This dashboard feature is admin only.", "reason": "admin_only"}`
  before any Hermes handler runs. Without a session the gate's own `401` (or `302` to `/login`)
  comes first, as before.
- A request that names a private path answers `403` with `"reason": "private_path"`.
- A socket off the list closes before accept with `4401` and the reason `auth: edgecity_admin_only`
  (the SPA shows its sign-in banner for the terminal).
- A gateway method off the list answers a JSON-RPC error, code `4031`, data
  `{"reason": "admin_only", "method": ...}`.
- The Plugins nav entry is hidden and `/plugins` is sent to `/` (kept from 1.2.0). The other nav
  entries still show and their pages show load errors: a broader nav hide is UX for later; the 403s
  are the security property.

### Editing the list

Edit `RESIDENT_HTTP`, `RESIDENT_WS_PATHS` or `RESIDENT_GATEWAY_METHODS` in `_resident_guard.py`.
An HTTP row is `(methods, pattern, why)`: a pattern matches path segments, `{x}` is one non-empty
segment, a final `**` is one or more further segments, and `SPA` is the page rule (a GET outside
`/api`, `/auth`, `/login`, the API docs and `/dashboard-plugins`). Both the URL path and the ASGI
scope path must match a row. A gateway method row is `name: (rule, why)`, where the rule is `None`,
`BYTES_ONLY` (no host `path`) or `NO_ALWAYS` (no persistent approval). Admins are never checked
against the tables. The Hermes-backed tests classify every route and method by these tables, so a
new row needs no test change; removing a row a test relies on (for example `/api/sessions`) does.

### Private paths

Even on a listed route, a non-admin request is refused when its URL path, or any path-carrying
query parameter (`path`, `cwd`, `file`, ... or any value that looks like a path), names this
plugin's directory (`.dashboard-auth-edgecity`), a dotenv file (`.env`, `.env.*`, `*.env`,
`.envrc`), `plugins/`, `hooks/`, `agent-hooks/`, the Hermes checkout (`hermes-agent/` and the
running Hermes source tree wherever it is), `state.db*`, `sessions.sqlite3` or `config.yaml`, as
written or resolved (`~`, `..`, symlinks, `file:` URLs). The same rule covers the path parameters of
the listed gateway methods (`cwd` on `session.create`). Separately, `.dashboard-auth-edgecity` is
added to Hermes's own read guard for the Files and `/api/fs` routes
(`web_routers/files.py:78`), so nobody, admins included, downloads the signing key through the
dashboard.

Because every version before 1.3.0 let any session download that store, 1.3.0 replaces the signing
key once on first start (a `key_epoch` row in the store) and drops every session row: everyone,
residents and admins, signs in again once after the roll.

### Fail closed

- A request the tables do not name, a value that cannot be read as a path, or an exception in
  the guard is a refusal, never a pass and never a 500.
- If the HTTP seam is missing (`gated_auth_middleware` or its `JSONResponse` renamed), `register()`
  raises `ResidentGuardNotInstalled` before registering the provider; Hermes then refuses to serve
  a gated dashboard without a provider (`web_server.py:1139`). The dashboard is down for everyone
  until the plugin is fixed; that is the intended failure.
- If the socket seam is missing (`web_server_chat._ws_auth_reason`), the embedded chat is
  switched off for every session (`_DASHBOARD_EMBEDDED_CHAT_ENABLED`, `web_server.py:383`): the
  one exception design rule 4 allows, logged at ERROR.
- If tickets cannot carry a role, every socket is a resident's: the console and terminal close to
  admins too (logged at WARNING).
- The gateway seam installs the first time a resident opens `/api/ws` (`tui_gateway.server` starts
  threads at import, so it is not imported at plugin load); until it is in place, and if it ever
  fails, a resident's `/api/ws` is refused.

### Loopback

With the gate off (`auth_required` false: a local `hermes dashboard`), every request arrives with
no session and the legacy socket token is a resident's, so a loopback dashboard gets the resident
list: no console, no terminal, no config. On village boxes the gate is always on. A local operator
who needs the full console runs Hermes without this plugin.

### How it is installed

`register()` installs the guard before it registers the provider. Each wrapper is one layer: a
wrapper already there (an earlier load, or 1.2.0's) is replaced, wrapping what it wrapped.

| Seam | Hermes 0.21.5 | What the wrapper does |
|---|---|---|
| `dashboard_auth.middleware.gated_auth_middleware` | imported at call time by `web_server._dashboard_auth_gate` (`web_server.py:645`); sets `request.state.session` before `call_next` (`middleware.py:129/:170/:201`) | calls the gate with a guarded `call_next`: admin passes; otherwise `RESIDENT_HTTP` and the private-path rule, else 403; the request's role goes into a context variable |
| `dashboard_auth.ws_tickets.mint_ticket` / `consume_ticket` | imported at call time by `routes.py:463` (`POST /api/auth/ws-ticket`), `web_server_chat.py:240` and `web_routers/display.py:61`; `extra` rides in the ticket (`ws_tickets.py:36`) | stamps the minting request's role into the ticket; reads it back on consumption; refuses a Bot Desktop display ticket minted under a non-admin |
| `web_server_chat._ws_auth_reason` | every gated socket's credential check: console and PTY via `chat_ws._ws_gate` (`chat_ws.py:118`, late-bound), sidecars via `_ws_auth_ok` (`web_server_chat.py:298`), TTS (`audio.py:398`), kanban (`plugin_api.py:57`) | stamps the socket's role (ticket role; `internal` for the PTY child's credential; resident for the loopback token) and refuses a path the role may not open |
| `tui_gateway.ws.handle_ws` and `tui_gateway.server.dispatch` | the `/api/ws` route imports `handle_ws` at call time (`chat_ws.py:588`); every frame goes through `server.dispatch(req, transport)` in `asyncio.to_thread` (`ws.py:361`) | carries the socket's role into every dispatch (a context variable; the socket on the transport as a fallback) and answers a resident only on `RESIDENT_GATEWAY_METHODS` |
| `web_routers.files._SENSITIVE_MANAGED_DIR_NAMES` | read at call time by `_is_sensitive_path` (`files.py:92`) | adds `.dashboard-auth-edgecity`, for every session |

Logs go to `dashboard-auth-edgecity.resident-guard`: one code per decision and the running counts,
never the email, a token, a ticket or a path. Denials at INFO (`denied_not_listed`,
`denied_private_path`, `denied_error`, `denied_ws_resident`, `denied_ws_internal`,
`denied_gateway_method`, `denied_display_ticket`, `denied_seam_*_missing`); allows and the hide at
DEBUG. The install line is `resident guard on (...)`; anything at ERROR from this logger is a seam
that did not install.

### On a Hermes bump

`test_hermes_every_http_route_is_listed_or_refused_for_an_owner` and
`test_hermes_every_gateway_method_is_listed_or_refused_for_an_owner` compare the real app with
`tests/hermes_routes_0.21.5.txt` and `tests/hermes_gateway_methods_0.21.5.txt`. A new route or
method is refused to residents until listed, and the test fails until someone looks at it. Re-read
the five seams above, then regenerate the two files for the new version.

## Tests

`python3 -m pytest -q` from the repository root runs `tests/` here (listed in `pytest.ini`).
Without Hermes importable (CI) the package still loads, the Hermes-free halves drive the real
wrappers through stand-ins for the gate, ticket store, socket auth and gateway, and the
`test_hermes_*` tests skip. To run those against the real seams and the real `web_server` app, put
the pinned Hermes source on `PYTHONPATH`:

```sh
mkdir -p /tmp/hermes-v2026.9.24
git -C ~/.hermes/hermes-agent archive v2026.9.24 | tar -x -C /tmp/hermes-v2026.9.24
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/tmp/hermes-v2026.9.24 python3 -m pytest -q plugins/dashboard-auth-edgecity/tests
```

(needs `fastapi`, `httpx` and `pyyaml` in that interpreter). `test_resident_guard.py` imports
`hermes_cli.web_server` and `tui_gateway` with a stand-in `HERMES_WEB_DIST` and a scratch
`HERMES_HOME`, stubs the plugin route bodies an admin reaches, and walks every route and gateway
method the app mounts as an owner. Nothing is cloned, installed or written outside the scratch
home. The route and method sets are pinned for 0.21.5; against another Hermes those two
comparisons skip and the rest still run.
