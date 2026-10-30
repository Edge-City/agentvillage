# Human As A Service (HaaS)

A buildathon mini-app for Edge City India: agents employ village humans for
tasks they cannot do. Live at https://haas.abhijitkadalli14.workers.dev.

One Cloudflare Worker serves two audiences:

- **Agents**: an MCP server at `POST /mcp` (streamable HTTP, JSON responses,
  no auth). Six tools, all reads: `browse_servants`, `draft_task`,
  `task_status`, `draft_enlistment`, `draft_invite`, `leaderboard`.
- **Humans**: the web app (the board, the roster, the leaderboard, a
  servant's badge, task pages, the owner's post and manage pages, invite and
  join pages) and the Telegram bot `@HASS_hUmAN_aS_A_seRviCe_Bot` (`/enlist`,
  `/tasks`, `/duty`, `/me`, `/recruit`).

## The loop

1. The agent calls `draft_task`. Nothing is stored: the draft is HMAC-signed
   into a `postUrl`. The agent also gets a `manageUrl`, whose key is derived
   from the task id, so it works once the task exists.
2. The agent asks its owner to tap the `postUrl`. **Dispatch a human** posts
   it and pings matching available servants on Telegram (or only the
   `servantId` the agent asked for).
3. A servant claims it, does it and submits proof: text, and a photo the
   browser shrinks to 1280 px JPEG before upload.
4. The agent reads `task_status`. When it is `submitted`, the owner opens the
   `manageUrl` to accept (minting the reward in Compute Credits to the
   servant) or reject with a note (back to the same servant, one more hour).

## Enlisting and recruiting

- **Enlisting.** A human sends `/enlist` to the bot (it replies with a
  one-tap login link) or signs in with the Telegram Login Widget at `/enlist`.
  An agent can draft its owner's profile with `draft_enlistment`: the
  `joinUrl` opens it prefilled after sign-in.
- **Recruiting.** Every servant has an invite link,
  `t.me/<bot>?start=r_<servantId>` (from `/recruit`, their badge page, or an
  agent's `draft_invite`). Whoever enlists through it is credited to the
  recruiter, who earns 5 CC when the recruit's first task is accepted. Top
  Recruiters is on the leaderboard.
- **Village data stays in the village.** The skill has the agent suggest
  people from Mosaic, Rolodex and the EdgeOS directory privately with its
  owner, and post a recruiting intention on Index through
  `record_intention`. HaaS only ever receives the recruiter's `servantId`;
  the owner forwards every invite.

This shape is what lets HaaS be a *generic* mini-app: a public read-only MCP
relay plus its own Context lines (`docs/MINI-APPS-QUICKSTART.md`). The only
write, posting, is the owner's tap on the web.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Router: `/mcp`, web pages, form actions, Telegram auth, photos |
| `src/mcp.ts` | JSON-RPC handling and the four tools |
| `src/store.ts` | D1 queries; every state change is one guarded `UPDATE` |
| `src/pages.ts`, `src/html.ts` | Server-rendered HTML with an escaping template |
| `src/tokens.ts` | Signed draft links, manage keys, session cookies |
| `src/telegram.ts` | Login Widget verification, bot messages |
| `src/bot.ts` | The bot's webhook (`/tg/webhook`): enlisting, `/recruit`, quick commands |
| `migrations/` | D1 schema |
| `catalog/` | `manifest.json` and `skills/haas/SKILL.md` for the control-plane PR |
| `test/` | End-to-end tests through `fetch`, D1 shimmed over `bun:sqlite` |

No runtime dependencies. It lives outside `mini-apps/` because that tree is
closed to anything but reviewed catalog files.

## Run it

```sh
bun test test/                       # or: npx bun test test/
printf 'HMAC_SECRET=dev\nDEV_LOGIN=1\n' > .dev.vars
npx wrangler d1 migrations apply haas --local
npx wrangler dev                     # /enlist shows a dev login without Telegram
```

Deploy: `npx wrangler d1 migrations apply haas --remote`, then
`npx wrangler deploy`. Secrets (`npx wrangler secret put`): `HMAC_SECRET`,
`TG_BOT_TOKEN` and `TG_WEBHOOK_SECRET` (the `secret_token` given to Telegram's
`setWebhook` for `https://<host>/tg/webhook`). The bot (`@HASS_hUmAN_aS_A_seRviCe_Bot`) needs
`/setdomain` in BotFather set to the Worker's host, or the Login Widget refuses
to load.

## Connect your agent

| Agent | How |
| --- | --- |
| Hosted Agent Village agent | Install **Human As A Service** from the Mini-apps sheet once Edge City adds the catalog entry (below). The control plane stages the skill and relays `mini-app.read` calls; nothing to configure. |
| Self-hosted Hermes | Add `mcp_servers.haas: {url: "https://haas.abhijitkadalli14.workers.dev/mcp"}` to `$HERMES_HOME/config.yaml`, copy `catalog/skills/haas/SKILL.md` to `$HERMES_HOME/skills/haas/SKILL.md`, restart the gateway. |
| Claude Code | `claude mcp add --transport http haas https://haas.abhijitkadalli14.workers.dev/mcp` |
| Any MCP client | Streamable HTTP at `https://haas.abhijitkadalli14.workers.dev/mcp`, no auth. |

Do not edit `config.yaml` on a hosted box: the installer owns it and the
approval gate checks it.

## The catalog entry

A generic mini-app goes into the control plane's catalog, in the cp repo
(`docs/MINI-APPS-QUICKSTART.md` section 2): `catalog/manifest.json` to
`control-plane/src/mini-apps/haas/manifest.json`, `catalog/skills/haas/SKILL.md`
to `control-plane/src/mini-apps/skills/haas/SKILL.md`, and `"haas"` appended to
`control-plane/src/mini-apps/catalog.json`. It is `visibility: "sandbox"`, so
it reaches only allowlisted tenants, and only once `MINI_APPS_MANIFESTS` and
`MINI_APPS_SKILL_DELIVERY` are on.

After any change to `catalog/skills/haas/SKILL.md`, update the `sha256` pin in
`catalog/manifest.json`, then check it with the shared validator:

```sh
node -e 'const v=require("./scripts/mini-apps-manifests.cjs");const r=v.validateManifest(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));console.log(JSON.stringify(r.ok?{ok:true}:r))' services/haas/catalog/manifest.json
```

The manifest's operation inputs mirror `TOOLS` in `src/mcp.ts`, with the
descriptions left out. Change both together.
