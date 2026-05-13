# EdgeOS Auth

EdgeOS credentials are private. Never show them in chat, paste them into logs, put them in URLs, or store them in public files.

## Runtime configuration

The runtime should inject:

- `EDGEOS_BASE_URL`: defaults to `https://api.edgeos.world`.
- `EDGEOS_POPUP_ID`: the Edge Esmeralda popup UUID for authenticated portal endpoints.
- `EDGEOS_POPUP_SLUG`: the Edge Esmeralda popup slug for the public calendar endpoint.
- `EDGEOS_API_KEY`: the per-user EdgeOS API key for this agent, usually with the smallest useful scopes. Expected to be sent as a bearer credential once Tule/SimpleFi confirm the final agent-auth contract.

Optional during the transition:

- `EDGEOS_USER_TOKEN`: a per-user OTP login bearer token. Prefer `EDGEOS_API_KEY` for agent runtime calls once available.
- `EDGEOS_TENANT_ID`: tenant override for anonymous public-calendar calls made from server-side runtimes with no Origin/Referer header.

## Normal agent auth

For protected EdgeOS endpoints, the expected agent-auth shape is to send the user-scoped EdgeOS credential as a bearer token:

```http
Authorization: Bearer ${EDGEOS_API_KEY}
```

This is the intended shape for `eos_live_...` per-user API keys, but it still needs final confirmation from EdgeOS before merge. OTP-issued access tokens are confirmed bearer credentials.

Use the least powerful key that can do the job:

- `events:read` for calendar, venue, tracks, and participant reads.
- `rsvp:write` for RSVP registration, cancellation, and check-in.
- `events:write` only when the user explicitly asks the agent to create or edit an event.

Directory access currently does not have a separate scope in the public schema. Use the smallest EdgeOS key that EdgeOS exposes for directory reads.

Do not use the Index Network `x-api-key` pattern for EdgeOS unless EdgeOS explicitly changes the contract. Index keys and EdgeOS keys are separate credentials.

## OTP flow

EdgeOS also supports a human OTP flow:

```http
POST /api/v1/auth/user/login
Content-Type: application/json

{ "email": "person@example.com" }
```

This sends a 6-digit code to the user. Then:

```http
POST /api/v1/auth/user/authenticate
Content-Type: application/json

{ "email": "person@example.com", "code": "123456" }
```

The response is:

```json
{
  "access_token": "<bearer token>",
  "token_type": "bearer"
}
```

Use OTP when the user is actively logging in or authorizing a runtime. Do not interrupt normal agent conversations by asking for OTP if a runtime credential is already installed.

## Creating a per-user API key

When the setup flow has a valid user bearer token, it can create a per-user API key:

```http
POST /api/v1/api-keys
Authorization: Bearer ${EDGEOS_USER_TOKEN}
Content-Type: application/json

{
  "name": "EdgeClaw agent",
  "scopes": ["events:read", "rsvp:write"]
}
```

The response includes the raw `key` exactly once. Store it encrypted, inject it into the agent runtime as `EDGEOS_API_KEY`, and never display it again.

## Path 1 handoff status

For hosted InstaClaw users, the intended flow is:

1. The attendee starts from the EdgeOS portal.
2. EdgeOS confirms the attendee identity and ticket/application context.
3. EdgeOS sends InstaClaw a short-lived handoff code or signed token.
4. InstaClaw verifies it server-side with EdgeOS.
5. InstaClaw stores the user's EdgeOS credential encrypted and injects it into the agent runtime.
6. The agent uses the confirmed EdgeOS credential shape for future EdgeOS calls, expected to be `Authorization: Bearer ${EDGEOS_API_KEY}`.

Open item: the exact EdgeOS-to-InstaClaw handoff endpoint is not yet documented in the public OpenAPI. Do not invent it. Until Tule/SimpleFi finalize it, treat this as an integration contract rather than an endpoint the agent can call.

## Failure handling

- `401` means the token is missing, stale, revoked, or not accepted for that endpoint. Ask the runtime/portal to refresh the credential. Do not ask the attendee to paste secrets into chat.
- `403` means the credential exists but lacks permission or the user does not have access to the popup/resource.
- `422` means the request shape is wrong. Re-check required path/query/body fields against `/openapi.json`.
