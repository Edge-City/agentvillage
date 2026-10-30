# Green Room: data contract

Green Room is a booking desk for creators: podcasters, YouTubers and writers at Edge City. This mini-app gives a resident's agent one capability: research a possible guest from **public** information and return a short, sourced brief with interview questions.

- Service: `https://green-room-eta.vercel.app/api/mcp` (MCP, protocol `2025-06-18`, `auth: none`)
- Desk website (where the resident sends invites): https://green-room-eta.vercel.app
- Source: maintained by @Varun-2538

## Operations

Both operations are public reads. They take the same input and change nothing.

| Operation | MCP tool | Input | Returns |
|---|---|---|---|
| `green-room.read` | `guest_brief` | `name` (≤120 chars), `links` (≤5 public `https` URLs, ≤500 chars each), `topic` (≤200 chars) | `{ story, facts: [{text, sourceUrl}], recentWork: [{title, url, date?}], questions: [8 strings], limited, sources }` |
| `green-room.questions` | `episode_questions` | same | `{ questions: [8 strings] }` |

Unknown arguments are rejected (`additionalProperties: false`). There is no identity input: no user id, Telegram id, username or email.

## What each call sends, and to whom

| Recipient | What it receives | Why |
|---|---|---|
| Green Room (Vercel, region `iad1`) | The call's `name`, `links` and `topic`, and the caller's IP address (for rate limiting only) | Runs the research |
| TinyFish (search and fetch APIs) | A search query built from the guest's public name and the handle in their first social link; the public URLs to read | Finds and reads the guest's public pages |
| Groq (model `openai/gpt-oss-120b`) | The guest's name, the topic, and the text of the public pages that were read | Writes the story and questions, citing sources |

Nothing about the resident is sent. The skill tells the agent never to pass anything from a Mosaic pair page (no `why`, overlaps or either person's answers): only the guest's public Rolodex name and links.

## What Green Room keeps, and for how long

- **The brief:** not stored. On this path the brief is returned and discarded; nothing is written to Green Room's database.
- **Rate limiting:** one counter row per caller IP address (key `mcp:<ip>`, a count and a window start), overwritten every hour. No arguments are stored.
- **Logs:** Vercel's runtime logs record errors for up to their retention window (about an hour on this plan). They never include the arguments.
- **Third parties:** TinyFish and Groq process each request under their own terms. Green Room doesn't ask either to store anything.

## Facts and sources

Every fact in a brief carries the URL it came from. A fact whose URL was not actually read or returned by search is dropped before the answer is sent. When little is public, `limited` is `true` and the story says so, rather than guessing.

## Limits and errors

- Each answer is under 128 KiB and arrives within 25 s. Green Room enforces a 22 s internal deadline, with 6 s for search and 8 s per page.
- At most 30 calls per caller IP per hour.
- Errors are an `isError` result whose one text item is exactly `{"code","detail"}`:

| `code` | When |
|---|---|
| `rate_limited` | More than 30 calls from one network in an hour |
| `unavailable` | Research failed or ran past the deadline, or a dependency is down |

Invalid arguments are refused by the input schema before the tool runs.

## Why these are `read` operations

The only personal data a call carries is a third person's **public** name and **public** links, which the resident chose to look up, the same as a web search. Nothing about the resident is sent, no state changes, and nothing is stored or forwarded to the person named. Inviting or messaging the guest happens outside this app, on the desk website, with the resident's own click, a World ID check and a limit of 5 invites a day.
