# EdgeOS Skill

EdgeOS is the identity spine and the source of truth for attendee status, calendar, venues, RSVP state, and the attendee directory.

Use these files when the user asks about the live event schedule, venue availability, RSVPs, attendee lookup, or their own Edge Esmeralda participation:

- `auth.md`: how the agent is authenticated to EdgeOS
- `calendar.md`: how to read schedule, tracks, venues, and availability
- `rsvp.md`: how to register, cancel, check in, and inspect RSVP state
- `directory.md`: how to search the attendee directory safely

Production API base URL: `https://api.edgeos.world`

Development API base URL: `https://api.dev.edgeos.world`

The live API contract is published at `/openapi.json` on each base URL. Prefer the live OpenAPI contract over stale examples in chat logs or old docs.
