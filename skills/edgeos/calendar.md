# EdgeOS Calendar

Use EdgeOS for live schedule, tracks, venues, room availability, RSVP-aware event views, and event creation.

Default base URL:

```text
https://api.edgeos.world
```

Use ISO 8601 datetimes with timezone offsets whenever possible. Edge Esmeralda is in Healdsburg, California, so local event times are Pacific time unless the API response says otherwise.

## Read public calendar

Use this when no user credential is available or the user only needs public schedule information:

```http
GET /api/v1/events/public/calendar?popup_slug=${EDGEOS_POPUP_SLUG}&start_after=${ISO_DATETIME}&start_before=${ISO_DATETIME}&search=${QUERY}&limit=200
```

No auth is required. The response is intentionally narrow: public, published events only. It excludes private/unlisted/draft/cancelled events and sensitive fields such as meeting URLs, owner IDs, tenant IDs, and internal content.

If the call is made from a server-side runtime with no `Origin` or `Referer`, include `X-Tenant-Id: ${EDGEOS_TENANT_ID}` when EdgeOS has provided it.

Important response fields:

- `results[].id`
- `results[].title`
- `results[].start_time`
- `results[].end_time`
- `results[].timezone`
- `results[].kind`
- `results[].tags`
- `results[].host_display_name`
- `results[].venue_id`
- `results[].venue_title`
- `results[].venue_location`
- `results[].track_id`
- `results[].track_title`
- `results[].occurrence_id` for recurring event instances
- `meta.allowed_tags`
- `meta.allowed_tracks`
- `meta.timezone`
- `meta.popup_id`

## Read authenticated calendar

Use this when the user asks for their RSVPs, private/user-specific schedule state, hidden events, meeting URLs, or details not exposed by the public calendar:

```http
GET /api/v1/events/portal/events?popup_id=${EDGEOS_POPUP_ID}&start_after=${ISO_DATETIME}&start_before=${ISO_DATETIME}&search=${QUERY}&rsvped_only=false&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

Useful filters:

- `event_status=published`
- `kind=<kind>`
- `venue_id=<uuid>`
- `track_ids=<uuid>`
- `tags=<tag>`
- `search=<text>`
- `rsvped_only=true`
- `include_hidden=false`
- `skip=<number>`
- `limit=<1..1000>`

The authenticated response can include `content`, `meeting_url`, `my_rsvp_status`, and other fields that are not available in the public calendar response.

## Event details

Use event detail before acting on a specific event:

```http
GET /api/v1/events/portal/events/${EVENT_ID}?occurrence_start=${ISO_DATETIME}
Authorization: Bearer ${EDGEOS_API_KEY}
```

For recurring events, include `occurrence_start` when the user is referring to a specific instance.

## Tracks

```http
GET /api/v1/tracks/portal/tracks?popup_id=${EDGEOS_POPUP_ID}&search=${QUERY}&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

Use tracks to explain programming themes or filter event recommendations.

## Venues

```http
GET /api/v1/event-venues/portal/venues?popup_id=${EDGEOS_POPUP_ID}&search=${QUERY}&limit=100
Authorization: Bearer ${EDGEOS_API_KEY}
```

Venue fields can include `title`, `description`, `location`, `formatted_address`, `capacity`, `tags`, `booking_mode`, photos, weekly hours, and exceptions.

## Venue availability

Use this before suggesting a room for a workshop, meetup, or session:

```http
GET /api/v1/event-venues/portal/venues/${VENUE_ID}/availability?start=${ISO_DATETIME}&end=${ISO_DATETIME}
Authorization: Bearer ${EDGEOS_API_KEY}
```

The response has:

- `open_ranges[]`: venue open windows
- `busy[]`: blocked windows, including event conflicts where available

For a direct availability check against a proposed event window:

```http
POST /api/v1/events/portal/events/check-availability
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json

{
  "venue_id": "<uuid>",
  "start_time": "2026-06-04T16:00:00-07:00",
  "end_time": "2026-06-04T17:30:00-07:00"
}
```

The response includes `available`, `conflicts`, and `reason`.

## Create or edit events

Creating, editing, cancelling, hiding, or otherwise changing events is a write action. Confirm with the user first in the current conversation.

Create:

```http
POST /api/v1/events/portal/events
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json

{
  "popup_id": "${EDGEOS_POPUP_ID}",
  "title": "Workshop title",
  "start_time": "2026-06-04T16:00:00-07:00",
  "end_time": "2026-06-04T17:30:00-07:00",
  "timezone": "America/Los_Angeles",
  "venue_id": "<uuid>",
  "visibility": "public",
  "status": "draft"
}
```

Update:

```http
PATCH /api/v1/events/portal/events/${EVENT_ID}
Authorization: Bearer ${EDGEOS_API_KEY}
Content-Type: application/json
```

Cancel:

```http
POST /api/v1/events/portal/events/${EVENT_ID}/cancel
Authorization: Bearer ${EDGEOS_API_KEY}
```

## Agent behavior

- For "what's happening now / next / today", query a bounded time window instead of the whole month.
- For "what should I attend", combine calendar data with the user's stated interests and explain why each pick fits.
- For "where can I host X", check venues and availability before recommending.
- If the public calendar lacks enough detail, use the authenticated portal endpoint before saying something is unavailable.
- Never invent times, locations, hosts, URLs, or RSVP state. If the API does not return it, say that it is not showing in EdgeOS.
