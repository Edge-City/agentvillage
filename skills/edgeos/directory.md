# EdgeOS Directory

Use the EdgeOS directory for attendee lookup and privacy-aware context. Use Index for ambient matching and agent-to-agent discovery when the user is asking "who should I meet" or when the answer needs negotiation between agents.

## Current user's participation

Check whether the authenticated human has participation in the popup:

```http
GET /api/v1/applications/my/participation/${EDGEOS_POPUP_ID}
Authorization: Bearer ${EDGEOS_API_KEY}
```

The response is one of:

- `type: "applicant"`: the user has their own application for this popup.
- `type: "companion"`: the user is an attendee on someone else's application.
- `type: "none"`: the user has no participation in this popup.

Use this before treating someone as an attendee, especially during setup or support.

## Search the attendee directory

```http
GET /api/v1/applications/my/directory/${EDGEOS_POPUP_ID}?q=${QUERY}&skip=0&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

The endpoint returns accepted applications with at least one product and respects `info_not_shared` masking.

Fields can include:

- `id`
- `first_name`
- `last_name`
- `email`
- `telegram`
- `role`
- `organization`
- `residence`
- `age`
- `gender`
- `picture_url`
- `brings_kids`
- `participation`
- `associated_attendees`

Treat every field as permissioned. If EdgeOS masks or omits a field, do not infer or fill it in from memory unless the user directly gave you that information.

## CSV export

The API also exposes a CSV export for the directory:

```http
GET /api/v1/applications/my/directory/${EDGEOS_POPUP_ID}/csv
Authorization: Bearer ${EDGEOS_API_KEY}
```

Agents should avoid CSV export for normal chat. Prefer paginated JSON lookup. Use CSV only when the runtime is doing a controlled batch process with explicit authorization.

## Agent behavior

- For "is X coming?", search the directory and answer only with fields returned by EdgeOS.
- For "who is working on X?", search the directory when the user wants a literal attendee lookup. Use Index when the user wants ranked matches, proactive discovery, or agent-to-agent coordination.
- Do not expose private email addresses casually. If `telegram` or another contact field is available, ask before drafting an intro or message.
- If multiple people match, show a short disambiguation list and ask which one they mean.
- If the user asks for sensitive attributes, apply privacy judgment even if the field exists. Prefer "I can only use what attendees chose to share."
- On `401`, treat the credential as stale or missing. On `403`, treat it as an access/permission problem.
