# dashboard-auth-edgecity

Hermes dashboard auth for Edge City tenants. It registers three things with Hermes:

| Provider | Kind | Who uses it |
|---|---|---|
| `edgecity` | interactive session (password form) | the tenant's owner: email, then a one-time code sent by the control plane; landing admins through `/admin/dashboard-sso` |
| `edgecity-archive` | token only, never offered at login | the archive job (DATA-66), with the tenant's `archive_read` bearer (DATA-88) |
| a route wrapper around Hermes's token seam | middleware | scopes the `archive_read` bearer to two routes |
| a wrapper around Hermes's cookie gate | middleware | makes plugin management admin only (SEC-1) |

The owner flow is described in `docs/deployment.md` ("Edge City authentication and local
verification"). This README covers the `archive_read` bearer and admin-only plugin management.

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

## Admin-only plugin management (SEC-1)

Residents may not install plugins; admins may (Carter, 12 Oct 2026). A Hermes plugin is arbitrary
Python running as `hermes` inside the gateway, so a plugin install is outside what approval.md
gates. Hermes puts every plugin route behind `_require_token`, which under the cookie gate only
checks that some session exists, so this plugin narrows it.

### What is covered

Every request, any method but `HEAD` and `OPTIONS`, whose path is one of five prefixes or lies
below one (`prefix` exactly or `prefix/...`, matched on path segments): `/api/dashboard/agent-plugins`,
`/api/dashboard/plugins`, `/api/dashboard/plugin-providers`, `/api/memory/provider` and
`/api/memory/providers`. At Hermes v2026.9.24 that is these 17 routes, found by walking the real
app's routes in `test_hermes_every_plugin_route_hermes_mounts_is_covered` (which fails if Hermes
adds a plugin-named core route the matcher misses):

| Method | Route | Hermes file:line |
|---|---|---|
| `GET` | `/api/dashboard/plugins/rescan` (rescans on a GET) | `web_routers/dashboard_ui.py:149` |
| `GET` | `/api/dashboard/plugins/hub` (the Plugins page) | `dashboard_ui.py:156` |
| `GET` | `/api/dashboard/plugins/catalog` (the Plugins page) | `dashboard_ui.py:181` |
| `POST` | `/api/dashboard/agent-plugins/install` | `dashboard_ui.py:222` |
| `POST` | `/api/dashboard/agent-plugins/<name>/enable` | `dashboard_ui.py:255` |
| `POST` | `/api/dashboard/agent-plugins/<name>/disable` | `dashboard_ui.py:262` |
| `POST` | `/api/dashboard/agent-plugins/<name>/update` | `dashboard_ui.py:269` |
| `DELETE` | `/api/dashboard/agent-plugins/<name>` | `dashboard_ui.py:284` |
| `POST` | `/api/dashboard/agent-plugins/activate` | `dashboard_ui.py:290` |
| `PUT` | `/api/dashboard/plugin-providers` (memory provider, context engine) | `dashboard_ui.py:317` |
| `POST` | `/api/dashboard/plugins/<name>/visibility` | `dashboard_ui.py:345` |
| `PUT` | `/api/memory/provider` (the same `memory.provider` key as `plugin-providers`) | `web_routers/ops.py:497` |
| `GET` | `/api/memory/providers/<name>/config` | `web_routers/memory_providers.py:520` |
| `PUT` | `/api/memory/providers/<name>/config` | `memory_providers.py:563` |
| `POST` | `/api/memory/providers/<name>/setup` (pip-installs the provider plugin's declared dependencies, runs its declared setup commands) | `memory_providers.py:540` |
| `POST` | `/api/memory/providers/<provider>/oauth/start` | `memory_oauth.py:51` |
| `GET` | `/api/memory/providers/<provider>/oauth/status` | `memory_oauth.py:65` |

The memory-provider routes are plugin management by another prefix: memory providers are Hermes
plugins, the SPA calls these routes only from the Plugins page (`web/src/pages/PluginsPage.tsx`
:358, :469, :477, :503), and `setup` installs code. Leaving them open beside a closed
`plugin-providers` would be a sibling path to the same config key.

Not covered, each for a reason:

- `GET /api/dashboard/plugins` exactly (`dashboard_ui.py:131`): the manifest list every page
  loads to mount dashboard plugin tabs (`web/src/plugins/usePlugins.ts:87`), not the Plugins page.
- `GET /dashboard-plugins/<plugin>/<file>` (`dashboard_ui.py:383`): enabled plugins' static assets.
- `/api/plugins/<name>/...`: a dashboard plugin's own API, defined by that plugin's module (52 routes
  of the bundled `kanban` and `hermes-achievements` at v2026.9.24), mounted only for enabled
  plugins and gated by Hermes's `_plugin_api_runtime_gate`. That is a plugin's feature, not plugin
  management.
- `GET /api/memory` and `POST /api/memory/reset`: memory status and data, not provider selection.

Query strings are not part of the match, so `?profile=` variants are covered. A trailing slash
is under the prefix too; `//api/...` and `/api//dashboard/...` match no Hermes route (tested: no
plugin handler runs). `HEAD` and `OPTIONS` are left to Hermes: they are not mutations, and FastAPI
routes neither to these handlers (a `HEAD` on the rescan GET is a 405).

Matching is on both the parsed URL path (what the gate matches on) and the ASGI scope path (what
the router dispatches on), with no normalisation: a request is on the surface when either path is,
and when the two disagree (a percent-encoded `?` or `#`) and either one so much as starts with a
prefix, it is on the surface too.

### The allow-list

Admin is exactly `session.provider == "edgecity" and session.org_id == "admin"`, both plain
strings. The `edgecity` provider mints `org_id = "admin"` only in `complete_login`, the landing
admin SSO exchange with the control plane (`/dashboard-admin/exchange`); the owner's email-code
login mints `"owner"`. Nothing else is admin: no session, a token principal
(`request.state.token_authenticated`, any service bearer), a session from another provider, any
other role, or an exception while deciding. There is no email list and no route deny-list.

### What a resident sees

- Every covered route answers `403` with
  `{"error": "forbidden", "detail": "Plugin management is admin only.", "reason": "plugin_admin_only"}`.
  The request never reaches Hermes's handler. Without a session the gate's own `401` (or `302` to
  `/login`) comes first, as before.
- The Plugins nav entry is hidden and `/plugins` (also under a proxy prefix) is sent to `/`. The
  SPA's `index.html` served to a non-admin gets, before `</head>`, two `<style>` rules hiding the
  nav link whose `href` ends in `/plugins` (and its `<li>`) and a `<script>` that replaces
  `location` with the base path's `/` whenever the path is `/plugins`, on load and on every
  client-side navigation. It is cosmetic: the API is what is closed. Only a `200` `text/html`
  response with no `content-encoding` that carries Hermes's bootstrap
  (`window.__HERMES_BASE_PATH__=`) is changed; the login page, `/api/` and `/auth/` responses
  are never read, an admin's page is byte-identical, and anything else goes out unchanged.
  Starlette hands a middleware every response as a stream, so the body is read up to 4 MiB; a
  bigger one, or one that carries an ASGI message, goes out untouched.
- Plugins already installed and enabled before this version keep running. This closes the door;
  it does not clean the room.

### Loopback

With the gate off (`auth_required` false: a local `hermes dashboard`), Hermes's cookie gate hands
every request on with no session, so nothing is admin and the surface is closed there too. On
village boxes the gate is always on.

### How it is installed

`register()` replaces `hermes_cli.dashboard_auth.middleware.gated_auth_middleware` with a wrapper
(`_plugins_admin.install`), after the providers are registered. `web_server._dashboard_auth_gate`
imports the attribute at call time (`web_server.py:645`), so the wrapper takes on the next
request. It calls the original gate with a guarded `call_next`: the gate has set
`request.state.session` before it calls `call_next` on every authenticated path (cookie, refreshed
cookie, native-app bearer), so the guard judges the verified session and the refreshed path's
rotated cookies still land on a 403. One layer: a wrapper already there (an earlier load of the
plugin) is replaced, wrapping the gate it wrapped. If the install fails the gate is left as it is
and the log says plugin management is NOT restricted. The wrapper is installed even when the
`edgecity` provider cannot start (no `TENANT_ID`): with no edgecity provider nobody is admin.

Logs go to `dashboard-auth-edgecity.plugins-admin`: one code per decision and the running counts,
never the email, token or path. Denials at INFO (`denied_non_admin`, `denied_no_session`,
`denied_token_principal`, `denied_other_provider`, `denied_error`); `admin_allowed` and
`html_hidden` at DEBUG.

## Tests

`python3 -m pytest -q` from the repository root runs `tests/` here (listed in `pytest.ini`).
Without Hermes importable (CI) the package still loads, the Hermes-free halves drive the real
wrappers through a stand-in seam and cookie gate, and the `test_hermes_*` tests skip. To run
those against the real seam, gate, registry and (`test_plugins_admin.py`) the real `web_server`
app, put the pinned Hermes source on `PYTHONPATH`:

```sh
mkdir -p /tmp/hermes-v2026.9.24
git -C ~/.hermes/hermes-agent archive v2026.9.24 | tar -x -C /tmp/hermes-v2026.9.24
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/tmp/hermes-v2026.9.24 python3 -m pytest -q plugins/dashboard-auth-edgecity/tests
```

(needs `fastapi` and `httpx` in that interpreter). `test_plugins_admin.py` imports
`hermes_cli.web_server` with a stand-in `HERMES_WEB_DIST` and a scratch `HERMES_HOME`, and stubs
the plugin route bodies an admin reaches, so nothing is cloned, rescanned or written.
