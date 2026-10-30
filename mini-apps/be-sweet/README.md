# Be Sweet: contract

A generic (public read) mini-app. Two MCP tools, both read-only, both with a closed empty input schema.

| Operation | MCP tool | Sends | Returns |
| --- | --- | --- | --- |
| `be-sweet.prompts` | `be_sweet_prompts` | `{}` only | Three questions that help a person find their own words, a privacy note, how to send a voice affirmation, an optional app link (null unless set), two rules |
| `be-sweet.how_to_share` | `how_to_share_a_story` | `{}` only | An AI-disclosure first line, an invitation, the ways to reach John F. Kim directly (the Be Sweet share page when configured, and a Telegram direct message), two consent choices, four rules |

**Service.** `service.kind: mcp`, `auth.mode: none`, protocol `2025-06-18`, JSON answers (no event stream, no sessions, no redirects). Requests over 4 KiB are refused; answers stay well under 32 KiB. A Cloudflare Worker on the owner's personal account, free plan.

**What it keeps.** Nothing. No storage of any kind (no KV, no database), no logging (`observability` off, no `console` calls, no tail), no cookies, no outbound calls. Because every tool takes no arguments, a call carries no identity and no data from the resident or the conversation. Cloudflare sees the calling server's IP at its edge, as any host does; the service never receives or records it.

**Third parties.** None receives data from this app. The `how_to_share_a_story` answer lists the ways a person may choose, on their own, to reach John F. Kim (a Telegram direct message, and the Be Sweet share page when configured). Nothing is sent to Telegram by the app or the agent.

**The resident's own conversation.** Agent Village's consent brief applies to what a resident tells their own agent: authorized staff and research personnel can read conversations, and messages pass to AI model providers. Be Sweet is built so nothing personal needs to be said to the agent: the prompts are answered by the resident for themselves, and the skill tells the agent not to ask for answers, names or stories, and to say why if the resident starts.

**Stories.** The app never accepts a story. A person who chooses to tell one reaches John directly, by one of the ways the `how_to_share_a_story` answer lists. A story sent to John on Telegram stays in his Telegram and on his own devices until November 30, 2026, then he deletes it unless the teller says "keep". Nobody under 18.

**Money.** None. Everything is a gift; the tool descriptions tell the agent never to mention prices, money, tips, wallets or payment.

**Errors.** Any argument returns an `isError` result carrying exactly `{"code": "invalid_arguments", "detail": "..."}`. An unknown tool is a JSON-RPC error `-32602`. The service has no rate limit of its own and no other error codes.

**Other routes.** `GET /` (a human page), `GET /stand` (a small embeddable card, no numbers) and `GET /v1/stand` (the same as JSON). These are not mini-app operations.

**Retention.** The service will be taken down or re-reviewed by November 30, 2026. A new version bumps the manifest version.

**Owner.** John F. Kim (GitHub `jfk-cil`). Personal project of Love Your Neighbor Baking Co.
