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
- **Their own sessions**: the list (`GET /api/sessions`, their own rows only, see "What a resident
  can see of other sessions"), and, for one of their own sessions only, read, read around a
  message, timeline, latest descendant, export, rename and delete. A session is the resident's
  when Hermes stamped the resident's own dashboard login on it (`<provider>:<user id>`), or when it
  came in on one of the box's messaging channels (`RESIDENT_SESSION_SOURCES`: Telegram and the
  other platforms) and no other dashboard login owns it; a row with neither is not. Search, bulk
  delete, delete-empty and prune act across sessions the guard cannot attribute before the handler
  runs, so from 1.3.1 they are admin only; from 1.3.2 so are the box-wide counts
  (`GET /api/sessions/stats`, `GET /api/sessions/empty/count`) and the list with `?full=1`.
- **The web chat's uploads**: `POST /api/chat/image-upload`.
- **The approvals card**: `/api/plugins/av-approval/**`, reserved for av-approval's own dashboard
  routes. None is mounted at this version.
- **Sockets**: the chat gateway, `/api/ws`, and (1.4.0) the Chat tab, `/api/pty`, on the terms in
  "The Chat tab" below.
- **The Chat tab (1.4.0)**: the dashboard's terminal chat with the resident's own agent, as the
  resident's own login (below).
- **Chat gateway methods** on `/api/ws`: handshake (`ping`, `gateway.capabilities`,
  `client.capabilities`), chats (`session.create`, `.resume`, `.list` and `.most_recent` with their
  own rows only, `.title`, `.close`, `.delete`, `.interrupt`, `.events.since`), `prompt.submit`, answering the agent
  (`approval.pending`, `approval.received`, `approval.respond`, `request.answer`), uploads
  (`image.attach_bytes`, `image.detach`, `file.attach` and `pdf.attach` with bytes only, never a
  host path) and `model.options`. Every method that names a chat answers only for one of the
  resident's own (below).
- **Approvals: once, session or deny.** A resident answers an approval prompt with `once`,
  `session` or `deny`, by `approval.respond`, by a response frame or by `request.answer`. `always`,
  which writes `command_allowlist` into `config.yaml` (`tools/approval.py:380-391`), and any other
  value are refused (`4031`) and counted (`denied_gateway_always`). **`always` is admin only.**

### A resident's own chats on the gateway (1.3.1, 1.3.2)

- **A live chat** is the resident's when this connection created it, or when Hermes stamped the
  connection's own login on it (`auth_user_id`, a reconnect or a resume). A landing admin's chat
  (another login) and the terminal's (no login) are not. Every method that takes a `session_id`
  (title, close, interrupt, events, prompt, approvals, uploads, `model.options`) is refused for
  any other chat.
- **A stored session** may be reopened or deleted (`session.resume`, `session.delete`) when it is
  the resident's by the rule above, or this connection created it, and no live chat under another
  login holds it. The guard looks the exact id up; a prefix or a title is refused.
- **Requests the agent raised.** A method-less frame (a response to a server request,
  `server_requests.py:201`) or `request.answer` passes only when it answers an open request on a
  chat this connection owns and is attached to, of a kind in `RESIDENT_SERVER_REQUESTS`
  (`approval` and `clarify`), and for an approval only with once, session or deny. A reply to an
  id this connection never received is refused. Hermes's other prompts over the socket (`sudo`,
  `secret`, whose answer goes into `.env`, the vault prompts, the desktop GUI reads, `tour`) are an
  admin's to answer.
- **`request_id`.** `approval.respond` and `approval.received` with a `request_id` pass only when
  that id is pending on the chat they name, so Hermes's box-wide fallback
  (`methods_prompt.py:1206-1233`) never runs for a resident.
- **Profiles.** A resident may name no `profile` but the box's own (`RESIDENT_PROFILES`): the guard
  reads ownership from that store only.
- **The chat's directory.** A resident's `session.create` runs in `$HERMES_HOME/resident-chat`
  (`RESIDENT_CWD_NAME`), created 0700 on first use with an `AGENTS.md` link to the box's own so the
  agent keeps the village rules. A `cwd` outside it (`$HERMES_HOME`, `/`, a symlink out) is
  refused, and if the directory itself is a symlink the chat is refused. Not `$HERMES_HOME`, because
  on village boxes that is where config.yaml, plugins, hooks and the key store live, and Hermes
  expands `@file:` against the chat's directory (`prompt_turn.py:590-604`).
- **File references (1.3.2).** A resident's `prompt.submit` may carry an `@file:` reference only to
  a file in `RESIDENT_FILE_DIRS` under `$HERMES_HOME`: `attachments/` (where `file.attach` stages
  an upload, so the `ref_text` it returns works), `composer-pastes/` (the desktop app's long
  pastes) and `resident-chat/`. The reference is read by Hermes's own parser
  (`parse_context_references`) from the text as sent and as Hermes's sanitiser hands it on, and its
  target is resolved as Hermes resolves it (`~`, relative to the chat's directory) and through
  every symlink: `attachments/../config.yaml`, a link in `attachments/` to config.yaml, a private
  name (`.env`, `config.yaml`, ...), a directory or anything outside the three are refused, and
  only from a chat that runs in `resident-chat` (a resumed Telegram chat runs elsewhere, so it
  takes no `@file:`). Any other `@file:` and every `@folder:` (any case, after Unicode folding,
  paste markers and the sanitiser) is refused, and so is any gateway-internal `_` parameter
  (`_turn_author`, `_hosted_task`). Hermes then expands what it admits from the chat's directory
  (`allowed_root` is the chat's cwd, plus `composer-pastes/`): a paste and a `resident-chat` file
  are inlined; an upload in `attachments/` is outside that workspace, so Hermes keeps the
  reference in the message with its own note and the agent reads the file with `read_file`.

### The Chat tab (1.4.0)

Residents keep the dashboard chat (Carter, 13 Oct 2026: six residents sent 34 dashboard-chat
messages in 14 days). At Hermes 0.21.5 the Chat tab is `/api/pty` (`chat_ws.py:432`): `hermes --tui`
behind a pseudo-terminal, attached to this dashboard's gateway over `/api/ws` with the URL in its
environment (`HERMES_TUI_GATEWAY_URL`). In 1.3.x that URL carried Hermes's one process-wide internal
credential (every method, no login), so the tab was admin only. From 1.4.0 a resident's tab gets a
credential of its own, and the child is the resident on the gateway.

**When a resident's `/api/pty` opens.** All checked before the socket is accepted (`pty_admission`);
a refusal closes it `4401` with `auth: <reason>`:

| Asked for | Rule | Reason |
|---|---|---|
| no login (the loopback token) | refused: the tab needs a ticket Hermes stamped the login from | `edgecity_pty_no_login` |
| `profile` | none or `current` only (`RESIDENT_PTY_PROFILES`): any other scopes `HERMES_HOME` and skips the attach URL, so the TUI would spawn a gateway the guard never sees (`web_server_chat.py:325-389`) | `edgecity_pty_profile` |
| `cwd` (the workspace) | none, or exactly `$HERMES_HOME/resident-chat` | `edgecity_pty_cwd` |
| `resume` | a chat of the resident's own (`session_visible` on the stored owner; a prefix is read as Hermes reads it) | `edgecity_pty_resume` |
| `channel` | new, or one this login's Chat tab runs on; never another login's (it names the tab's active-session file and its sidebar feed) | `edgecity_pty_channel` |
| a new `channel` past the login's own bound | refused: the login already holds `PTY_CHANNELS_PER_LOGIN` = 16 channels (see Limits) | `edgecity_pty_channels` |
| `attach` | anything: a resident's token is keyed under its own login in Hermes's PTY registry, so it never reattaches another login's terminal | |

Every value of a repeated parameter is checked (Hermes reads the last).

**Before anything spawns.** The PTY handler then settles the chat itself: with a channel and no
`resume` it reopens the channel's active-session file, and Hermes follows a resume to its newest
continuation (`web_server_sessions.py:36`). The guard checks that chat again (it must be the
resident's) where Hermes resolves it (`_resolve_chat_argv_async`), and pins the workspace. A refusal
there shows one red line in the tab (`Chat could not start: That chat is not yours.`) and closes
it `1011`.

**The per-PTY credential.** For an accepted tab the guard mints 32 random bytes, kept in memory with
`{user_id, provider, role: resident, pty_id, minted_at}`, and builds the child's
`HERMES_TUI_GATEWAY_URL` (`/api/ws`) and, with a channel, `HERMES_TUI_SIDECAR_URL` (`/api/pub`) with
`?internal=<that credential>`, through Hermes's own URL builder. The attach URL is always set (without
it the TUI spawns its own gateway); if it cannot be built the tab is refused. No value of the child's
environment carries the process-wide credential. On a socket, `consume_internal_credential` answers
that credential with the resident's own `{user_id, provider}`, which Hermes stamps on the socket
exactly as it stamps a ticket's, so:

- on `/api/ws` the child is a resident: `RESIDENT_GATEWAY_METHODS`, its own chats only, no
  `always`; the chats it creates carry the resident's login (`auth_user_id`) and run in
  `resident-chat`;
- on `/api/pub` it publishes only on the tab's own channel;
- it opens nothing else, only from a loopback peer, at most two sockets per path at once;
- the process-wide credential stays the admin terminal's (ROLE_INTERNAL); an admin's tab is
  Hermes's own, unchanged.

The credential is revoked when its PTY closes (the tab closed, a registry reap or eviction,
shutdown) or its child exits, and when a tab never spawned (a reattach, a failed start); a revoked
credential is refused (`4401 auth: internal_invalid`), its open sockets are closed
(`4401 auth: edgecity_pty_revoked`), and a frame still in flight is refused `4031`.

**Limits.** Hermes's registry holds 16 terminals for the whole box, and a resident could fill them.
So one login holds at most `RESIDENT_PTYS_PER_LOGIN` = 3: at the limit the login's own oldest
detached terminal is closed to make room, and if all three are attached the fourth tab shows
Hermes's own `Chat could not start: too many chat terminals are open in other tabs.`

**The channel table (1.4.0, round 5).** The guard remembers which login's Chat tab runs on each
channel, so no resident opens a tab on another login's (SEC1-refute4 S-rf4-1: at first it was one
box-wide table of 4096 that nothing emptied, written before any limit, so one resident's open-and-close
tabs, or plain wear, since the SPA mints a channel per Chat mount, filled it in a minute and then
refused every resident's next tab until a restart). Now:

- a channel is recorded only when its tab's spawn is committed, after every other check, under the
  same lock as the terminal limit; admission and a tab refused later record nothing;
- a resident's entry is dropped when the channel's last live credential is revoked (the tab closed,
  the child exited, a reap or eviction, a tab that never spawned, the 120 s sweep). That opens no
  reach: a later tab on the channel has its resume re-checked against its own login, and `/api/pub`
  is bound per credential;
- the bound is per login, `PTY_CHANNELS_PER_LOGIN` = 16. A resident holds no more entries than live
  terminals (3), so it meets the bound only if an entry outlives its terminal; a new channel past it
  is refused `4401 auth: edgecity_pty_channels` for that login only. One login never blocks another;
- an admin is never refused: its channel is recorded when its terminal runs and never over another
  login's, and at the bound its own oldest entry makes room (an admin's tab holds no credential, so
  nothing else drops it). The SPA's channels are `chat-<random UUID>`, so a displaced admin entry is
  not one a resident can name.

**What the TUI could do on its own, and what is closed.** The TUI process runs as `hermes` with the
box's provider environment (secrets kept by Hermes's design, as for the Telegram gateway), and the
resident's keystrokes reach it. Everything it sends to the gateway meets the method list; what it
does locally is closed from the guard's side by the child's environment:

| In the TUI | What it does | Closed by |
|---|---|---|
| `!cmd`, `{!cmd}` | `shell.exec` | the method list: `error: This gateway method is admin only.` |
| `/plugins`, `/skills`, `/tools`, unknown commands | `slash.exec`, then `command.dispatch` | the method list |
| `/model`, `/reload`, `/reload-mcp`, `/browser`, `/rollback`, `/compress`, `/branch`, billing, ... | `config.set`, `reload.*`, `browser.manage`, ... | the method list |
| the composer's editor (`/prompt`, `/compose`, Ctrl+G), whose own shell escape is a shell | spawns `$VISUAL`/`$EDITOR` | both set to a path that does not exist: the spawn fails, the edit is dropped |
| `/setup` | spawns `$HERMES_BIN setup`, which writes config | `HERMES_BIN` set to that path |
| a link clicked in the transcript | spawns `xdg-open <url>` | mouse and clicks off (`HERMES_TUI_DISABLE_MOUSE`, `..._CLICKS`), `BROWSER` set to that path |
| input history (Up arrow) | reads and appends `$HERMES_HOME/.hermes_history`, which every login's TUI shares | the child's `HOME` and `HERMES_HOME` are the login's own `resident-tui/<id>` (0700): its history, log, theme, widgets and `/terminal-setup` stay there |
| `/exit`, `/quit`, `/update` | refused in hosted dashboard mode | `HERMES_TUI_DASHBOARD=1` forced |
| the TUI exits (crash, Ctrl+C, Ctrl+D) | the PTY ends; Hermes closes the tab, never a shell (the child is `node`, spawned without one) | the credential is revoked with it |
| `/theme-info` | prints four theme variables | nothing secret |
| `/heapdump` (and a dump at start or at a memory threshold) | writes a V8 snapshot of the TUI, which holds its environment (the box's provider keys, the tab's own credential), to `$HERMES_HEAPDUMP_DIR`, up to 2 GiB per directory | `HERMES_HEAPDUMP_DIR` forced to a path under `/dev/null` (`PTY_NO_HEAPDUMP_DIR`): the dump's `mkdir` fails, whoever runs it, and the tab shows `heapdump failed: ...` |
| user widgets | imports and runs every `$HERMES_HOME/tui-widgets/*.mjs` at start and on change, here `resident-tui/<id>/tui-widgets/` | not closed (carried, see below): nothing in the dashboard or the TUI writes there |

There is no `$VAR` expansion and nothing in the TUI prints its environment. The git-branch probe
runs `git rev-parse` in `resident-chat`, read-only.

**Residual, carried (not closed by the guard).**

- **User widgets** (SEC1-refute4 N-rf4-1). The TUI executes `tui-widgets/*.mjs` under its
  `HERMES_HOME`, the login's `resident-tui/<id>`. Only the agent's own file tools (approval-gated,
  running as `hermes`) can write there, the same class as the box's own `tui-widgets/` and `plugins/`
  before 1.4.0, and those tools can already run code as `hermes`. There is no cheap closure: the TUI
  runs as the same user, so a mode is no barrier, and the loader watches the directory's parent and
  hot-loads a directory that appears in place of anything put there.
- **The child's environment.** The TUI child holds the box's provider keys and its own credential,
  as an admin terminal's holds the process-wide one; the agent's terminal can read
  `/proc/<pid>/environ` (SEC-2).

**What a resident sees.** On every start the TUI asks the gateway for a few things a resident may not
read (`config.get`, `wake.start`, `commands.catalog`, `setup.status`), and it resizes with
`terminal.resize`: each shows one `error: This gateway method is admin only.` line and the TUI
carries on with its defaults (the method list is unchanged in this round). The sidebar's live feed
(`/api/events`) stays admin only, so a resident's sidebar shows no tool feed.

### What a resident can see of other sessions

Nothing, from 1.3.2 (SEC1-refute2 S-r3-1: the lists used to carry every session's title,
first-message preview and, with `?full=1`, system prompt).

- **`GET /api/sessions`** carries the resident's own rows only. Hermes's handler answers first (its
  validation and errors stand); the guard then reads Hermes's own list under the request's filters
  and order, 100 rows at a time from the start (`LIST_PAGE_ROWS`, at most `LIST_SCAN_ROWS` = 5000
  stored rows), drops every row that is not the resident's, and pages through the rest with the
  request's `limit` and `offset`. `total` counts the resident's rows only. A failure answers 503
  `"reason":"session_list_unavailable"`, never Hermes's box-wide page. `?full=1` (any `full` but a
  false word) is admin only.
- **`GET /api/sessions/stats` and `GET /api/sessions/empty/count`** are admin only (box-wide
  counts). The Sessions page then shows no stats strip and no "Delete empty" count; it already
  could not delete empty sessions.
- **Gateway `session.list`** (a long handler: the pool worker writes the reply through the
  transport, so the guard dispatches it with a transport that filters that one reply) and
  **`session.most_recent`** (inline) carry only the resident's rows; their rows carry no `user_id`,
  so each id's owner is read from the store. When the box's newest chat is not the resident's,
  `session.most_recent` answers Hermes's own "none" (`session_id: null`). A failure is a 4031.
- **Content and actions** (messages, export, timeline, search, every chat action) answer only for
  the resident's own sessions, as in 1.3.1. The archive job's bearer and admins see every row.

### What is admin only

Everything else, including everything Hermes adds in a later version until someone lists it:
plugins (install, enable, disable, the hub), config and raw config, `.env` (read, write, reveal),
files and `/api/fs/*`, hooks, MCP servers, skills, cron, models and providers, credentials,
profiles (beyond the two reads), pairing, webhooks, messaging platforms, logs, analytics, gateway
start/stop/restart/update, Hermes update, backups and imports, git, local models, the Hermes
Console (`/api/console`), a Chat tab on another profile, workspace, channel or login's chat, the
browser's event feed (`/api/events`, and `/api/pub` but for a Chat tab child on its own channel),
TTS streaming, the Bot Desktop bridge, dashboard plugins' own APIs (kanban), and every gateway
method not listed above (`shell.exec`, `cli.exec`, `plugins.manage`, `slash.exec`,
`command.dispatch`, `config.set`, `config.get`, ...), from the desktop app and the Chat tab alike.

### What a resident sees

- A route off the list answers `403`
  `{"error": "forbidden", "detail": "This dashboard feature is admin only.", "reason": "admin_only"}`
  before any Hermes handler runs. Without a session the gate's own `401` (or `302` to `/login`)
  comes first, as before.
- A request that names a private path answers `403` with `"reason": "private_path"`.
- A session route for a session that is not the resident's answers `403` with
  `"reason": "not_own_session"`, and a gateway frame that names another chat or answers another
  chat's request answers `4031` with `"reason": "not_own_session"`.
- A socket off the list closes before accept with `4401` and the reason `auth: edgecity_admin_only`
  (the SPA shows its sign-in banner for the terminal).
- A Chat tab the resident may not open closes before accept with `4401` and
  `auth: edgecity_pty_profile`, `_cwd`, `_resume`, `_channel`, `_channels` or `_no_login`; one whose settled chat
  is another login's shows `Chat could not start: That chat is not yours.` and closes `1011`. A Chat
  tab child's socket refused by its credential's rules closes `4401` with `auth: edgecity_pty_peer`,
  `_sockets`, `_channel` or `edgecity_admin_only`.
- A gateway method off the list answers a JSON-RPC error, code `4031`, data
  `{"reason": "admin_only", "method": ...}`.
- The Plugins nav entry is hidden and `/plugins` is sent to `/` (kept from 1.2.0). The other nav
  entries still show and their pages show load errors: a broader nav hide is UX for later; the 403s
  are the security property.

### Editing the list

Edit `RESIDENT_HTTP`, `RESIDENT_WS_PATHS` or `RESIDENT_GATEWAY_METHODS` in `_resident_guard.py`
(the Chat tab's terms are `RESIDENT_PTY_PROFILES`, `RESIDENT_PTYS_PER_LOGIN`, `PTY_SOCKETS_PER_PATH`,
`PTY_FORCED_ENV` and `PTY_DROPPED_ENV`).
An HTTP row is `(methods, pattern, why)`: a pattern matches path segments, `{x}` is one non-empty
segment, a final `**` is one or more further segments, and `SPA` is the page rule (a GET outside
`/api`, `/auth`, `/login`, the API docs and `/dashboard-plugins`). Both the URL path and the ASGI
scope path must match a row. A gateway method row is `name: (rule, why)`, where the rule is `None`,
a tuple of rules: `BYTES_ONLY` (no host `path`), `NO_ALWAYS` (no persistent approval),
`OWN_SESSION` / `OWN_SESSION_IF_GIVEN` (a live chat of the resident's), `OWN_STORED` (a stored
session of the resident's), `OWN_REQUEST` (the `request_id` is pending on that chat), `PINNED_CWD`
(the resident chat directory), `NO_FILE_REFS` (no `@folder:`, no `@file:` outside `RESIDENT_FILE_DIRS`), `ANSWER` (the response
frame rules) or `OWN_ROWS` (a list whose reply carries only the resident's rows). `RESIDENT_FILE_DIRS`
names where a resident's `@file:` may point. `RESIDENT_SERVER_REQUESTS` names the agent's prompts a resident may answer and
`RESIDENT_SESSION_SOURCES` the channels whose sessions are the resident's. Admins are never checked
against the tables. The Hermes-backed tests classify every route and method by these tables, so a
new row needs no test change; removing a row a test relies on (for example `/api/sessions`) does.

### Private paths

Even on a listed route, a non-admin request is refused when its URL path, or any path-carrying
query parameter (`path`, `cwd`, `file`, ... or any value that looks like a path), names this
plugin's directory (`.dashboard-auth-edgecity`), a dotenv file (`.env`, `.env.*`, `*.env`,
`.envrc`), `plugins/`, `hooks/`, `agent-hooks/`, the Hermes checkout (`hermes-agent/` and the
running Hermes source tree wherever it is), `state.db*`, `sessions.sqlite3` or `config.yaml`, as
written or resolved (`~`, `..`, symlinks, `file:` URLs). The same rule covers the path parameters of
the listed gateway methods, and `prompt.submit` text is covered by the file-reference refusal
above. Separately, `.dashboard-auth-edgecity` is
added to Hermes's own read guard for the Files and `/api/fs` routes
(`web_routers/files.py:78`), so nobody, admins included, downloads the signing key through the
dashboard.

**The agent's own reads (1.3.1, 1.3.2).** At `register()` the key store (`.dashboard-auth-edgecity`) and
this plugin's own directory join Hermes's agent read deny-list
(`agent.file_safety._READ_DENIED_DIRS`), which `read_file` and `@file:` consult. If that tuple is
gone or reshaped the plugin refuses to load (`ResidentGuardNotInstalled`), as for the HTTP seam.
And `agent.context_references._ensure_reference_path_allowed` is wrapped so that an `@file:` /
`@folder:` reference to a private path under `$HERMES_HOME` (config.yaml, `plugins/`, `hooks/`, the
key store, `state.db`) or in the Hermes checkout is refused for every caller, admins and the
messaging gateway included, wherever this plugin loads. From 1.3.2 that wrapper is required too: if
Hermes renames `_ensure_reference_path_allowed`, the plugin logs ERROR and refuses to load
(SEC1-refute2 N-r3-3; in the messaging gateway it is the only `@file:` line). **This is defence in depth, not custody:**
the agent's terminal can still read the store, and anyone holding the key and one live admin row
can sign an admin cookie. Moving the key out of the `hermes` user's reach is SEC-2.

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
- The guard installs whenever the plugin loads, whichever dashboard login providers are
  configured beside it (Hermes's bundled `basic`, `nous`, `self_hosted` or `drain`), and also when
  the edgecity provider itself cannot be built: then nobody is admin. A session from any other
  provider is a resident.
- A ticket minted inside a gateway call (`display.observe`, the Bot Desktop bridge) carries that
  connection's role: an admin's is an admin's; the PTY child's and a resident's are a resident's.
- A session route or a resume whose owner lookup fails, or finds no session, is refused.
- A resident's session list the guard cannot filter (no reader, a failure, a body of another
  shape) answers 503 over HTTP and 4031 on the gateway, never the box-wide list.
- The gateway seam installs the first time a resident opens `/api/ws` (`tui_gateway.server` starts
  threads at import, so it is not imported at plugin load); until it is in place, and if it ever
  fails, a resident's `/api/ws` is refused.
- The Chat tab's seams install all or none (`install_pty`). Without them, or without the gateway
  seam, a resident's `/api/pty` is refused as in 1.3.x (logged at WARNING); nothing else changes.
- A resident's tab without a login, a context the guard did not set, an environment it cannot
  rebuild, an attach URL it cannot build, or a spawn that does not carry the credential it minted
  is refused; a credential that is not live opens nothing.

### Loopback

With the gate off (`auth_required` false: a local `hermes dashboard`), every request arrives with
no session and the legacy socket token is a resident's, so a loopback dashboard gets the resident
list: no console, no Chat tab (the token carries no login), no config. On village boxes the gate is always on. A local operator
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
| `agent.file_safety._READ_DENIED_DIRS` | read at call time by `get_read_block_error` (`file_safety.py:343-385`) | adds the key store and this plugin's directory; required (the plugin refuses to load without it) |
| `agent.context_references._ensure_reference_path_allowed` | read at call time by `_expand_path_reference` (`context_references.py:291`) | also refuses a private path under `$HERMES_HOME` or the Hermes checkout, for every caller; required (1.3.2) |
| `web_server_chat._resolve_chat_argv_async` | late-bound by `chat_ws.py:33`; resolves the PTY's argv and env after accept | a resident's tab: the settled chat must be its own; the env rebuilt with the per-PTY credential (`resident_chat_env`) |
| `web_server_chat.PtyBridge` | imported at call time by the PTY handler (`chat_ws.py:434`) | a subclass whose `spawn` binds the credential to the bridge; closing it or the child's EOF revokes it |
| `web_server_chat.PTY_REGISTRY.attach_or_spawn` / `.detach` | the keep-alive registry (`pty_session.py`) | a resident's `?attach=` keyed under its login; at most 3 terminals per login |
| `dashboard_auth.ws_tickets.consume_internal_credential` | imported at call time by `_ws_auth_reason` (`web_server_chat.py:236`) | a per-PTY credential answers with the resident's identity; anything else is Hermes's |
| `hermes_cli.web_server_sessions._open_session_db_for_profile` | what the session routes read (`web_routers/sessions.py`) | the guard's read-only owner lookup for `/api/sessions/{id}...`, `session.resume`, `session.delete` and the gateway list rows |
| `hermes_cli.web_routers.sessions.get_sessions` | the `GET /api/sessions` handler | called directly, compact rows, 100 at a time, to build a resident's own list |
| `agent.context_references.parse_context_references` | Hermes's `@`-reference parser (`context_references.py:151`) | reads a resident's `@file:` references exactly as Hermes will |

Logs go to `dashboard-auth-edgecity.resident-guard`: one code per decision and the running counts,
never the email, a token, a ticket or a path. Denials at INFO (`denied_not_listed`,
`denied_private_path`, `denied_error`, `denied_ws_resident`, `denied_ws_internal`,
`denied_gateway_method`, `denied_gateway_always`, `denied_gateway_session`,
`denied_gateway_file_ref`, `denied_gateway_cwd`, `denied_gateway_profile`, `denied_answer_*`,
`denied_not_own_session`, `denied_context_reference`, `denied_display_ticket`, `denied_full_list`,
`denied_session_list_error`, `denied_gateway_list`, `denied_gateway_list_error`,
`denied_seam_*_missing`, and for the Chat tab `denied_pty_profile`, `_cwd`, `_resume`, `_channel`,
`_channels`, `_no_login`, `_peer`, `_sockets`, `_revoked`, `_limit`, `_attach_url`, `_no_context`,
`_error`); `pty_grant_minted`, `pty_resident_spawned`, `pty_revoked_<why>`, `pty_channel_released` and
`pty_resident_evicted` at DEBUG;
allows, the hide and the list filter (`resident_list_filtered`,
`resident_list_truncated`) at DEBUG. The install line is `resident guard on (...)`; anything at ERROR from this logger is a seam
that did not install.

### What verify@b2 reads back after the roll

Placeholders only (`<BOX>`, `<OWNER_AT>`, `<ADMIN_AT>`, `<T>`); never a cookie value in a report.
Fresh owner and admin sign-ins are needed after the roll.

- `plugin.yaml` says `version: 1.4.0`.
- The install line `resident guard on (...)` is logged at INFO. If the dashboard logs at WARNING,
  its absence proves nothing; the proof is then no ERROR from `dashboard-auth-edgecity` plus the
  probes below.
- **Old cookies are dead:** a cookie from before the roll (the one-time key replacement that
  arrived in 1.3.0 and that 1.3.2 carries; `_KEY_EPOCH` is unchanged) answers `GET /api/auth/me` with 401
  `{"error":"session_expired",...}`.
- **An owner on the fs routes:** `GET /api/fs/download?path=<home>/.dashboard-auth-edgecity/sessions.sqlite3`
  answers 403 `"reason":"admin_only"` (the guard); an admin's answers 403 with Hermes's own body.
- **No `always` for an owner:** over the owner's `/api/ws`,
  `{"method":"request.answer","params":{"id":"srq-x","result":{"choice":"always"}}}` and the frame
  `{"id":"srq-x","result":{"choice":"always"}}` answer error `4031`.
- **An owner's session routes:** `GET /api/sessions/<an admin or terminal session id>/messages`
  answers 403 `"reason":"not_own_session"`; one of the owner's Telegram sessions answers 200.
- **New in 1.3.2: an owner's `GET /api/sessions` shows no other login's rows:** every row's
  `user_id` is the owner's own login or a Telegram sender (none is an admin's `edgecity:<id>`, none
  is a `tui`/`cli`/`cron` row without a login), and `total` equals the number of the owner's rows;
  `GET /api/sessions?full=1` and `GET /api/sessions/stats` answer 403 `"reason":"admin_only"`.
- **New in 1.3.2: an owner's `@file:` to an upload is accepted:** over the owner's `/api/ws`,
  `file.attach {"session_id":<own chat>,"data_url":"data:text/plain;base64,aGk=","name":"t.txt"}`,
  then `prompt.submit` with the `ref_text` it returned, answers without error; `prompt.submit`
  `@file:<home>/attachments/../config.yaml` answers error `4031`.
- **New in 1.4.0: the owner's Chat tab.**
  - The owner opens the Chat tab and chats: the TUI answers, and a message gets the agent's reply.
    (On every start a few `error: This gateway method is admin only.` lines are expected, see "The
    Chat tab".)
  - `/api/pty?ticket=<T>&profile=x` closes `4401` `auth: edgecity_pty_profile`.
  - `/api/pty?ticket=<T>&resume=<an admin's chat id>` closes `4401` `auth: edgecity_pty_resume`.
  - In the tab, `!env`, `/plugins install x` and `/reload` each answer one
    `error: This gateway method is admin only.` line; Ctrl+G opens no editor.
  - The tab's `/api/ws` connection is the owner's: a chat started in the tab appears in the owner's
    `GET /api/sessions` once it has a message, with `user_id` `edgecity:<owner id>`.
  - The dashboard log has no `pty start failed` for the owner's own tab.
  - Round 5: the owner opens and closes the Chat tab 20 times (a reload or a chat switch each time),
    and the 21st tab still opens and chats; no `edgecity_pty_channel` or `edgecity_pty_channels`
    refusal for an owner's fresh tab.
  - Round 5: `/heapdump` in the owner's tab answers `heapdump failed: ...`, and no file appears under
    `<home>/resident-tui/*/.hermes/heapdumps/`.
- Kept from 1.3.0: owner `PUT /api/config` gives `admin_only`; owner `/api/env` 403; owner
  `/api/dashboard/plugins/hub` 403, admin 200; owner `/api/console` closes 4401
  `auth: edgecity_admin_only`; owner `/api/ws` `shell.exec` answers 4031; admin `/api/console` sends
  `ready`; the yaml check prints `False True`.

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
