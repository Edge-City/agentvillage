---
name: edge-esmeralda-2026
description: Background on a PREVIOUS Edge City popup, Edge Esmeralda 2026 (May 30 – Jun 27 2026, Healdsburg, CA) — not the current event. The current event is Edge City India (Oct 11 – Nov 1 2026, Mandrem, Goa). Use this skill only when the user explicitly asks about Edge Esmeralda or Edge City's history/mission; never present its dates, weeks, themes, venues, wiki logistics, or popup id as current or as applying to Edge City India. For Edge City India questions, use the `edge-india` skill instead.
version: 3.1.3
author: Edge City
tags: [edge-city, edge-esmeralda, popup-village, community]
---

# Edge Esmeralda 2026 (previous popup) — Agent Skill

> **Previous popup, not the current event.** You serve residents of **Edge City India** (Mandrem, Goa, India — October 11 to November 1, 2026). Everything below describes **Edge Esmeralda 2026**, an earlier Edge City popup. Use it only as background when the user explicitly asks about Edge Esmeralda or Edge City's history, and always frame it in the past tense. Never answer an India question (schedule, "what's happening", venues, accommodation, travel, tickets, health, kids, transport, local tips) from this skill: India logistics come from the `edge-india` skill and India's live schedule from `edgeos`. If neither has the India detail, say you don't have it for Edge City India and point the user to the Edge City portal or the organisers.
>
> The Edge City website reference (mission, leadership, roadmap, ecosystem) is about the organisation and can be used as general background.

This skill holds data about **Edge Esmeralda 2026**, a month-long popup village hosted on the EdgeOS platform.

- **Dates**: May 30 – June 27, 2026
- **Location**: Healdsburg, California (Sonoma County)
- **Organizer**: Edge City, a 501(c)(3) nonprofit "society incubator"
- **Co-founders**: Janine Leger, Timour Kosters
- **Weekly structure**: 4 weeks, each with thematic programming
- **Themes**: AI, Consciousness, Health & Longevity, Governance & Coordination, Hard Tech, Privacy, d/acc, Art & Culture, Decentralized Tech, Bio & Neuro, New Urbanism, Education, Energy & Climate, Food Systems
- **Contact**: info@edgeesmeralda.com
- **Website**: https://edgecity.live | https://www.edgeesmeralda.com

This skill is a **knowledge layer** about the popup itself. For live calendar, RSVP, venue, and directory API calls, use the sibling `edgeos` skill, passing it the popup id from §1 (by default `edgeos` uses the current village's popup). For discovery and intent-based matching, use the `index-network` skill.

---

## 1. Popup constants (use these with the `edgeos` skill)

- **`popup_id`**: `43746fd0-bce2-472b-93e4-a438177b2dff`
  Pass this as the `popup_id` parameter to the `edgeos` skill's read calls that need it: `GET /events/portal/events?popup_id=...` (always pass it; see the `edgeos` skill §3), `GET /applications/my/directory/{popup_id}` and `GET /event-venues/portal/venues?popup_id=...`. Agents cannot create or change events or venues for any popup. The `edgeos` API key is bound to the current village's popup, so the events and venues calls with this id answer `403` ("This API key does not have access to this popup"); when they do, tell the person the previous popup's live schedule isn't reachable from their agent.
- **`popup_slug`**: `edge-esmeralda-2026` (informational; not used by EdgeOS API calls).
- **`event_base_url`**: `https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/`
  Use this as the prefix for event links by appending the `event_id` returned by the EdgeOS API.

### Week dates and themes

Standardized weeks for Edge Esmeralda 2026. Week 1 is extended back to May 30 to cover opening weekend; weeks 2-4 match the published programming preview.

| Week | Range | Published theme | Emphasis |
|---|---|---|---|
| 1 | May 30 – June 7, 2026 | Protocols for Flourishing | Health & Longevity, Consciousness, Wellbeing, Bio |
| 2 | June 8 – June 14, 2026 | Intelligence and Autonomy | AI, Neurotech, Governance & Coordination, Hard Tech, Privacy |
| 3 | June 15 – June 21, 2026 | Emergent Futures & World Building | Art & Culture, Decentralized Tech, Creative AI & Technologies, Spatial Computing |
| 4 | June 22 – June 27, 2026 | Environments of Tomorrow | New Urbanism, Education, Energy & Climate, Food Systems |

Themes are the published programming emphasis for each week, sourced from the Edge Esmeralda programming preview. They are directional: themes overlap and some programs span multiple weeks. A theme describes the week's focus, not a given day's schedule. For the actual events on any day, query the live `edgeos` calendar; do not infer "today's events" or "today's track" from this table, and do not present a theme as the day's schedule. Some EdgeOS tracks run across the whole month and do not map one-to-one to these theme weeks.

When the user says "week 2", convert to `start_after=2026-06-08T07:00:00Z&start_before=2026-06-15T07:00:00Z` (PDT midnight = 07:00 UTC; `start_before` is the start of the day *after* the last day). Week 1 is `start_after=2026-05-30T07:00:00Z&start_before=2026-06-08T07:00:00Z`.

---

## 2. Attendee directory field guide

The `edgeos` skill exposes `GET /applications/my/directory/{popup_id}`. Pass the `popup_id` from §1. It works only with a human session token carrying `portal:directory:read` (`$EDGEOS_BEARER_TOKEN`), never with the `eos_live_` API key; see the `edgeos` skill §9. The directory lists the main applicants and spouses of accepted applications who hold a ticket (children are not listed). Each attendee record in `results[]` contains:

- `id` — the attendee id
- `first_name`, `last_name`, `email`, `telegram`
- `role`, `organization` — from the main applicant's application form; empty on a spouse's row
- `residence`, `age`, `gender`
- `picture_url`
- `category` — `main` or `spouse`
- `participation` — the attendee's tickets, each `{ id, name, slug, category, duration_type }`; these are ticket products, not dated weeks
- `associated_attendees` — always an empty list: a spouse is a record of their own

Response wrapper: `{ results: Attendee[], paging: { offset, limit, total } }`.

### Privacy

An attendee can hide any of `first_name`, `last_name`, `email`, `telegram`, `role`, `organization`, `residence`, `age` and `gender`; a hidden value appears as the literal string `"*"`. `picture_url`, `category` and `participation` are never masked, and only a main applicant's record carries masks. **Respect this** — do not try to infer or work around hidden data. If a field is `"*"`, tell the user that information is private.

### Useful query patterns (via the `edgeos` skill's directory recipe)

- Search by name, email or Telegram handle: `?q=QUERY` (it matches only shared values and does not search role or organization)
- Pagination: `?skip=0&limit=20` (default 100, at most 1000; page again only while `skip + results.length < paging.total`)
- `?hide_empty_rows=true` drops records with no shared name, email, Telegram, role or organization. There is no filter by week, family or anything else.

---

## 3. Event tags (curated for Edge Esmeralda 2026)

When filtering events via the `edgeos` skill's `?tags=...` query, these are the supported values:

Consciousness, Health & Longevity, Wellbeing, Bio & Neuro, AI, Governance & Coordination, Hard Tech, Privacy, d/acc, Art & Culture, Decentralized Tech, Creative AI & Technologies, Spatial Computing, New Urbanism, Education, Energy & Climate, Food Systems.

Tags are case-sensitive and may be combined: `?tags=AI&tags=Privacy` returns events tagged with either.

---

## 4. Reference content (wiki, website, newsletter)

For questions about Edge Esmeralda's logistics, the organization, or announcements, use the preprocessed reference files shipped alongside this skill. They are a frozen snapshot of the Esmeralda sources (last refreshed 2026-10-01, before the upstream indexer moved to India) and are no longer updated. When the Edge installer copies skills into the workspace, these files land under `skills/edge-esmeralda/references/`. If the `references/` directory is present, read the relevant file directly:

- **`references/wiki-content.md`** — Edge Esmeralda Wiki (tickets, accommodation, travel, venues, health, kids, transport, etc.)
- **`references/website-content.md`** — Edge City Website (mission, leadership, roadmap, ecosystem, media)
- **`references/newsletter-digest.md`** — Edge Esmeralda Newsletter (residencies, fellowships, housing, tickets, programming)

If the `references/` directory is missing (the upstream CI workflow that generates it has not run yet, or the files were not committed), tell the user the reference content is not available yet and point them at the primary sources: the Edge Esmeralda wiki at https://www.notion.so/317d45cdfc5981d2a571f52b024c5141, the newsletter at https://edgeesmeralda2026.substack.com, and https://edgecity.live.

### When to fetch which

- Tickets, pricing, scholarships, volunteering → **wiki**
- Accommodation, Hotel Trio, Airbnb, camping → **wiki**
- Travel, airports, getting to Healdsburg → **wiki**
- Venues, coworking, wifi → **wiki**
- Check-in, wristbands → **wiki**
- Health, gym, sauna, cold plunge → **wiki**
- Kids, families, kids camp → **wiki**
- Telegram groups: which ones exist, how to join → **wiki**
- What people are saying in the main village chat, chat summaries → **`geo-esmeralda` skill** (raw, time-windowed history of the main Telegram group; not covered by the wiki)
- Transport, bikes, rideshare → **wiki**
- Local discounts, merch → **wiki**
- Outdoor adventures, Russian River, hikes → **wiki**
- What is Edge City, mission, vision, leadership → **website**
- Roadmap, long-term plan, phases → **website**
- Ecosystem, projects, partners → **website**
- Residencies, fellowships, grants → **newsletter**
- Programming preview, how to get involved → **newsletter**
- Housing details, lodging options → **newsletter**
- Science partnerships, Alethios → **newsletter**

---

## 5. Cross-skill orchestration

Only when a user explicitly asks about Edge Esmeralda (the previous popup), route the work like this. Questions about Edge City India must not be routed here:

- **Calendar / RSVP / venue / directory API call** → `edgeos` skill. Pass `popup_id` from §1.
- **Discovery, intent-based matching, "who should I meet?"** → `index-network` skill.
- **Village chat ("what's the village discussing," "what's happening in the chat," "summarize the chat")** → `geo-esmeralda` skill (`telegram-messages` recipe) — raw, time-windowed history of the main Edge Esmeralda 2026 Telegram group. Synthesize a short bulleted summary; never dump raw messages or quote personal details beyond what the answer needs. If the local geo skill copy does not document `telegram-messages` yet, run `npx -y @geoprotocol/geo-edge-esmeralda-cli telegram-messages --help` for usage.
- **Community knowledge** (logistics, organization, announcements, "what is Edge City?") → this skill, §4.
- **Spatial / map / "what's near venue X"** → `geo-esmeralda` skill. Query `Venue` nodes via native graph queries for coordinates, or use the `edgeos` venue endpoint's `geo_lat` / `geo_lng` fields with haversine math for proximity ranking. Use the wiki (§4) for Healdsburg-area context.

---

## 6. Tips for answering well

- **Default date range** for broad Edge Esmeralda calendar queries: 2026-05-30 to 2026-06-27.
- **Convert relative dates** ("today", "tomorrow", "this Thursday") to ISO-8601 timestamps in `America/Los_Angeles`. Use the local date and UTC offset from your system timestamp — never derive the date from UTC alone.
- **Combine sources** when needed. "What experiments are running this week?" pulls from both the wiki (experiment descriptions) and the `edgeos` calendar (live schedule).
- **For venue questions**, first fetch the wiki for venue names / descriptions, then call the `edgeos` venues endpoint with `popup_id` from §1.
- **For attendee matching**, prefer the `index-network` skill (semantic signal search). The `edgeos` directory is the registration-side fallback when you need a specific person by name / org / role.
