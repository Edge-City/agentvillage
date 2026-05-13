# EdgeOS RSVP

Use RSVP endpoints only when the user clearly asks to register, cancel, check in, or inspect attendee/RSVP state.

RSVP write actions require the user's explicit confirmation in the current conversation. Do not register, cancel, or check in silently.

## List the user's RSVPs

```http
GET /api/v1/events/portal/events?popup_id=${EDGEOS_POPUP_ID}&rsvped_only=true&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

Use this for questions like:

- "What am I signed up for today?"
- "Do I have anything at 4pm?"
- "Show my RSVPs this week."

## Inspect participants for an event

```http
GET /api/v1/event-participants/portal/participants?event_id=${EVENT_ID}&occurrence_start=${ISO_DATETIME}&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

For recurring events, include `occurrence_start` when the user means a specific occurrence.

## Register for an event

Before registering:

1. Fetch the event details.
2. If it is recurring, identify the exact occurrence.
3. Confirm title, time, venue, and any capacity/approval caveat with the user.

Then:

```http
POST /api/v1/event-participants/portal/register/${EVENT_ID}
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json

{
  "role": "attendee",
  "message": "Optional note from the user",
  "occurrence_start": "2026-06-04T16:00:00-07:00"
}
```

Omit `occurrence_start` only for non-recurring events or when the API event detail indicates it is not needed.

## Cancel an RSVP

Before cancelling:

1. Fetch the user's RSVP state.
2. Confirm title, time, and occurrence with the user.

Then:

```http
POST /api/v1/event-participants/portal/cancel-registration/${EVENT_ID}
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json

{
  "occurrence_start": "2026-06-04T16:00:00-07:00"
}
```

The cancel body reuses the RSVP body shape. `role` and `message` are ignored on cancel.

## Check in

Checking in is also a write action. Confirm first.

```http
POST /api/v1/event-participants/portal/check-in/${EVENT_ID}
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json

{
  "occurrence_start": "2026-06-04T16:00:00-07:00"
}
```

## Agent behavior

- Never RSVP the user to an event without a fresh confirmation.
- For recurring events, do not assume "register" means every occurrence. Ask which date/time if unclear.
- If the API returns approval-pending, capacity, or waitlist-like state, report it plainly instead of saying the RSVP is complete.
- If the RSVP endpoint fails with `401`, ask the runtime/portal to refresh the EdgeOS credential. Do not ask the user to paste a key into chat.
- If it fails with `403`, explain that the user may not have access to that event or popup.
