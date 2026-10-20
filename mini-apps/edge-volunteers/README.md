# Edge City Volunteers mini-app

A volunteer's own schedule in their agent: their shifts, hours, plan, the open
shifts they could claim and their cover requests, plus the scheduling changes a
volunteer can already make in the Edge City Volunteers (ECV) app, each made only
after the owner says yes to its exact summary in chat.

- `skills/edge-volunteers/SKILL.md`: what the agent does and says.
- `mini-apps/edge-volunteers/manifest.json`: what the owner installs and grants.
- `plugins/village-bridge/_ecv.py`: the box-side argument checks and error text.

ECV is Edge City's own volunteer scheduling service
(https://edge-city-volunteers.vercel.app, repo `lucychen0103/Edge-City-Volunteers`).
Its MCP server already serves volunteers through OAuth; this mini-app reuses
that server and needs no change on ECV's side.

## Why named operations, not `mini-app.read`

ECV's data is per person and its MCP server answers only a signed-in volunteer,
so the public-read path does not fit. This follows the zzz.bot pattern: the
resident connects their own ECV account in the Mini-apps sheet, the app server
holds the grant, and the box sends one of eleven named operations. The box
never sees a token, endpoint, PIN or volunteer id.

## The contract Edge City's app server implements

**Connection.** OAuth 2.1 with PKCE S256 against the MCP resource
`https://edge-city-volunteers.vercel.app/api/mcp`. Discovery starts at
`https://edge-city-volunteers.vercel.app/.well-known/oauth-protected-resource`.
ECV supports dynamic client registration and client ID metadata documents;
register one client named "Edge City Agent Village". ECV's `/connect` page shows
the client name and the return host; the resident signs in there with their
Telegram username and PIN (or in one tap if the ECV app is already signed in on
that browser).

- Access tokens last an hour; refresh silently. Refresh works until the end of
  the day 7 days after the event ends, capped at 60 days from sign-in.
- A PIN reset, a withdrawal or a coordinator's revoke ends the connection at
  once (ECV re-checks the connection on every call). A 401 from ECV, or a failed
  refresh, is `ecv_reconnect_required`.
- **Volunteers only.** Right after connecting, call `tools/list` once. Keep the
  grant only if it lists `eciv_my_shifts` (a volunteer-only tool); otherwise
  drop it and answer `ecv_volunteer_only`. A staff grant never reaches these
  operations, and the box offers only the seven volunteer actions in any case.

**Operations.** Each maps to exactly one ECV tool. `arguments` is forwarded
unchanged as that tool's MCP `arguments`.

| `village` operation | ECV MCP tool | Kind |
|---|---|---|
| `ecv.initialize` | `eciv_initialize` | read |
| `ecv.guide` | `eciv_guide` | read |
| `ecv.my_hours` | `eciv_my_hours` | read |
| `ecv.my_shifts` | `eciv_my_shifts` | read |
| `ecv.get_shift` | `eciv_get_shift` | read |
| `ecv.plan_view` | `eciv_plan_view` | read |
| `ecv.open_shifts` | `eciv_list_open_shifts` | read |
| `ecv.my_requests` | `eciv_my_requests` | read |
| `ecv.move_targets` | `eciv_move_targets` | read |
| `ecv.propose` | `eciv_propose` | check (nothing changes; ECV writes one audit row) |
| `ecv.confirm` | `eciv_confirm` | write |

Not exposed: `eciv_feedback` (it writes a note to ECV's admins), every staff
tool, every staff action, and `brief`.

**Input.** The box checks every call against ECV's published input schemas
(volunteer `tools/list`, ECV 0.45.0) before sending; the app checks again with
the same rules and refuses anything else with `ecv_invalid` (HTTP 422):

- Reads: exactly the keys in the skill's table. Ids match ECV's uuid pattern,
  dates `YYYY-MM-DD`, `before` is 1–500 characters, `limit` and `days` are
  integers in the stated ranges, `topic`/`topics` from ECV's eight topics.
- `ecv.propose`: `{action, params, then?}`. `action` is one of `claim_shift`,
  `set_rest_day`, `set_extra_hours`, `plan_days`, `move_shift`, `ask_cover`,
  `cancel_cover_request`, each with exactly its params (see the skill). `then` is
  1–2 more `{action, params}` steps (ECV allows 3 changes in all for a
  volunteer).
- `ecv.confirm`: `{code}`, printable ASCII, 20–50,000 characters.

The box adds `turnId` to `ecv.propose` and `ecv.confirm`: a UUIDv5 of the
trusted session key and message id, never model input.

**The owner's yes.** ECV's propose returns a summary to show word for word and
a code valid for 10 minutes; ECV's confirm makes the change and is idempotent
(the same code again returns the first result). The app makes "a later owner
reply" a server rule:

- When `ecv.propose` returns a code (`structuredContent.code`, null when the
  change is blocked), store
  `sha256(code) → {owner, grant generation, turnId, expiresAt}` for 15 minutes.
- Refuse `ecv.confirm` with `ecv_confirmation_required` (HTTP 409) when the
  code's record is missing, belongs to another owner or grant, has expired, or
  carries the same `turnId` as this confirm.
- Never store the code itself, shift text or any ECV answer.

The box sends `X-Village-Operation: ecv.confirm` so the app admits the larger
body (a code can be ~50 KB). Both operations fit the 25-second timeout.

**Results.** Return the MCP result as
`{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
ECV puts a header with the event's time now on every reply, and states each
refusal as `REFUSED (<rule>): <reason>` with `isError: true`. The box scrubs
hidden characters at every depth and frames the result as untrusted data. The
native response limit is 262,144 bytes; an `ecv.plan_view` of 8 busy days fits.

**Errors.** Answer with HTTP 4xx/5xx and a JSON body `{"code": "<code>"}`. The box
replaces it with its own text (`_ecv.py` `ECV_ERRORS`), never upstream wording:

| `code` | When |
|---|---|
| `ecv_not_connected` | No ECV grant for this owner |
| `ecv_reconnect_required` | ECV answered 401, or refresh failed |
| `ecv_volunteer_only` | The grant is a staff account |
| `ecv_unavailable` | ECV answered 503 (its `MCP_ENABLED` kill switch, or `TOKEN_SECRETS` unset) or did not answer |
| `ecv_confirmation_required` | The confirm rule above |
| `ecv_invalid` | The arguments failed the app's check, or ECV answered JSON-RPC `-32602` |

Any other failure is `connection_or_request_refused`, which tells the agent not
to claim a change and to read `ecv.my_shifts` before proposing again.

**Limits.** ECV sets no per-person limit for MCP calls. Suggest 300 operations
per owner per UTC day at the app.

## Rollout

1. This overlay (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `edge-volunteers`, Gold Stars included, so this comes
   first.
2. The CP catalog entry, `edge-volunteers` 1.0.0 with the eleven operations in
   this order, offered to the Edge City India tenant only.
3. The app routes: the OAuth connection, the operation map, the confirm rule.
4. Project it to boxes on that roll.

On ECV's side nothing changes; its `MCP_ENABLED` switch turns the mini-app off
together with every other assistant connection.
