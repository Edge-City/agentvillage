# For Kicks flat approval card: the formatter spec

Carter's P0 (21 Oct): a For Kicks order is approved on the plain minimal card, not the technical one and
not an "AI summary (not checked)" line. Product ruling L17668 (a), For Kicks owner nonav L17670/L17696/L17701,
approval L17700/L17702. Three codebases build or check the same four strings, so this file is the one
spec and `forkicks-approval-card.json` (next to it) is the golden vector set. The app and the control plane
copy the JSON byte for byte into their own tests and must produce the same output for every vector.

Implementation of record (the box): `plugins/village-bridge/_forkicks.py` `card_fields`, `card_value_fits`.

## Who does what

| Part | Owner | What |
|---|---|---|
| App (`agentvillage-app` forkicks.ts) | context, ships LAST | At prepare, builds `approvalPayload` = exactly `{order, total, pickup, name}` from the saved draft and hashes it (payload_hash, as today). Returns the order's `preview` (today's `OrderPreview`) BESIDE `approvalPayload` in the prepare answer. At confirm, re-derives the four strings from the SAVED draft and refuses any difference. If the formatter refuses (either code), sends today's legacy `{appId, operation, preview}` payload instead. |
| Box (overlay `_forkicks.py`, v2.1.10 hotfix) | release, ships FIRST | Accepts both shapes. For the four-key shape it re-derives the strings from the `preview` the app returned beside the payload (saved in the per-draft record) and refuses a mismatch (`approval_card_invalid`) or an over-budget card (`approval_card_not_minimal`). Proposes the app's payload byte for byte, both shapes under the unchanged class `marketplace.app.action` and key `marketplace.app.action:forkicks.order.confirm:<draftId>` (approval L17713: no class change). |
| Control plane | context, after the box | The parent class's say entry quoting the four keys (below); `mini-apps-approval.js` request()/verify accept the four-key payload under the same key, bound to the draft (the draftId and order are no longer inside the payload). |

ORDER (nonav L17692): if the app emits the four-key shape before every box accepts it, every box before this
change refuses every order. Box tag + fleet update first, then the control plane, then the app. GATE (context
L17737): a box with this change sends `X-Village-Forkicks-Card: 1` on `forkicks.order.prepare` (and on no other
operation); the app emits the four-key payload ONLY on a prepare that carries it, so a box without it keeps
getting the legacy shape.

FALLBACK (review-b app#516 S1, lead L17847): the box's Python Unicode tables can be OLDER than the app's Node. The dev
box runs Python 3.11.8, `unicodedata.unidata_version` 14.0.0; Hermes requires Python >=3.11,<3.14; Node ships
Unicode 15-17. A text valid to the app (e.g. a display name with U+1FA77, Unicode 15) can then fail `card_fields`
on the box. So when a prepare answer carries a four-key payload that the box refuses with a card error
(`approval_card_invalid`, `approval_card_not_minimal`, `approval_card_too_long`; a mismatch included), the box logs
`card_fallback_legacy` (the code only) and calls `forkicks.order.prepare` ONCE more without
`X-Village-Forkicks-Card`. The app quotes again and stores a NEW draft (app#516 prepare: `randomUUID()` + INSERT
every call, no reuse) whose hash is the legacy payload's; only that draft is saved, returned to the agent and
confirmable here. The card draft was never saved on the box (checked_payload refuses before any write), so it is
never proposed or confirmed, and it expires with its quote. A second failure, or any other refusal (a bad hash, a
wrong draft), raises as before. The confirm path never prepares again. Vectors stay Unicode-version-neutral (no
code point newer than Unicode 14).

## The four strings

Input: the app's order preview `p` (keys `appId, draftId, quote, displayName, items, fulfilment, paymentMethod`,
optional `note`). Every check of today's technical card (`approval_summary` / the control plane's
`forkicksSummary`) runs first; any failure there is `approval_card_invalid`.

- `order`: one line per `p.quote.lines[i]`, in order: `<qty> × <name>`, then ` (<options joined by ", ">)` when
  the line has options. A line with NO options has no parentheses at all (`1 × Butter croissant`, never
  `(none)`; CONFIRMED L17744). Lines joined by U+000A (one item per line; product + lead L17778). `×` is U+00D7
  with one U+0020 on each side. Names and options are the merchant's text, verbatim (no quoting). Every line is
  listed; nothing is cut. Core 0.4.7 draws a U+000A inside a quoted value as ` ⏎ ` (U+0020 U+23CE U+0020,
  `MINIMAL_NEWLINE_MARK`) on the same visual line, not as a new line.
- `total`: `₹<p.quote.totalInr>, <payment words>`. `₹` is U+20B9; the amount is the integer in decimal, no
  separators. Payment words: `upi` -> `pay by UPI`, `card_on_pickup` -> `card at pickup`. **Product-confirm.**
- `pickup`: `<where> · <when>`; the separator is ` · ` (U+0020 U+00B7 U+0020). CONFIRMED (L17744).
  - where: `p.quote.location.name` (`p.fulfilment.type` is `pickup`). TODAY ONLY PICKUP ORDERS GET THE FLAT CARD
    (review-b ov#446 S1): the delivery address is the agent's free text (app forkicks-schema.ts:14), so a
    `delivery` order is `approval_card_not_minimal` (legacy, technical card) until an address allowlist lands
    (v2.1.12). The formatter still defines `Delivery to <p.fulfilment.deliveryAddress>` for that later change
    (CONFIRMED wording, product + lead L17744).
  - when: the date `p.fulfilment.date` when present, else the first 10 characters of `p.quote.location.opens`
    (the same date as the technical card's `Date (IST)`), written `<day> <Mon> <year>`: day without a leading
    zero, the month as `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`, e.g. `5 Nov 2026`. No weekday, no
    time, no "today" (the strings are re-derived later and must not depend on the clock; the quote's `closes`
    is optional). A month outside 1-12 or a day outside 1-31 is `approval_card_invalid`. **Product-confirm.**
- `name`: `p.displayName`, verbatim.
- No `note` key: the note is not on the card (known gap, Carter L17772; see the table below).

## What you see is what the order sends (security review)

The four rows must show everything the order sends that the agent can influence. Every preview field is either
shown, bound to a shown one, or the flat card is refused with `approval_card_invalid` (the app then sends the
legacy shape for that draft, whose technical card shows everything):

| Preview field | On the flat card |
|---|---|
| `appId` | constant `forkicks` (checked) |
| `draftId` | bound: the per-draftId approval key and record |
| `displayName` | shown (Name) |
| `paymentMethod` | shown (Total) |
| `quote.lines[i]` name, qty, options | shown (Order); `unitInr`/`lineInr` are the merchant's prices behind the shown Total |
| `quote.lines[i]` itemId, optionIds | bound: must equal `items[i]` (else refused) |
| `quote.totalInr`, `quote.location.name` | shown (Total, Pickup) |
| rest of `quote` | the merchant's own answer for this quoteId, not text the agent sends |
| `items[i]` | exactly `{itemId, optionIds, qty}`, equal to `quote.lines[i]` (else refused) |
| `fulfilment` | exactly `type` (shown), `locationId` (must equal `quote.location.id` / `quote.locationId` when present), `date` (shown), `deliveryAddress` (shown; only on a delivery, else refused); any other key refused |
| `note` | agent-written text sent to the café: NOT on the card. KNOWN GAP accepted by Carter (lead L17772, 21 Oct: "it's fine for now if there is a note the agent sends without the resident seeing it"); the note stays in Full details (the technical card's `Note:` line) |

So the APP builds exactly `{order, total, pickup, name}` and emits the legacy shape whenever the formatter refuses
(`approval_card_invalid` or `approval_card_not_minimal`), or the order fails on the box.

## No phantom lines (product + lead L17778; supersedes the earlier separator and allowlist rules)

One item per line, so a separator inside a name (`;` `,` `(` `)` `×` `·`, any lookalike) cannot fake a line, and
no rule looks at them: `Latte (oat)` and `Iced, oat` pass. What could fake a line is a line break or a
direction change inside a text, so:

- Control and format characters (Unicode Cc, Cf, also Cs, Zl, Zp: U+000A, U+000D, U+0085, U+2028, U+2029, bidi
  controls, zero-width characters) in any order text (item and option names, location name, delivery address,
  display name, note) are refused by today's technical-card check (`approval_summary` / `forkicksSummary`) with
  `approval_card_invalid`, before any flat-card rule. No shape carries them (the legacy shape fails too, as today).
  One exception (v2.1.13; approval RULING CLAIMS L18218): U+200C ZWNJ and U+200D ZWJ pass this check ONLY when BOTH
  neighbouring code points are letters or marks (Lo, Mn, Mc) of the SAME one of the ten Indic blocks (Devanagari
  U+0900-097F, Bengali U+0980-09FF, Gurmukhi U+0A00-0A7F, Gujarati U+0A80-0AFF, Oriya U+0B00-0B7F, Tamil
  U+0B80-0BFF, Telugu U+0C00-0C7F, Kannada U+0C80-0CFF, Malayalam U+0D00-0D7F, Sinhala U+0D80-0DFF); at a value
  edge, doubled, or next to anything else (Latin, a digit, a space, emoji, another block) they are refused as above.
  Core marks every joiner, so such a value still fails the budget rule (`approval_card_not_minimal`): the legacy
  shape. Vectors `d-zwj-*` / `d-zwnj-*`.
- A character core would draw as a mark (for example `⏎` U+23CE, `«` U+00AB, a no-break space is stricter: see the
  budget) is `approval_card_not_minimal` (budget rule below).
- Free text must not fake the Pickup row's ` · <date>` part or the Order row's ` ⏎ ` mark (security review). After
  NFKC normalisation:
  - a pickup location's name or a delivery address holding U+00B7 `·` (e.g. U+0387 normalises to it) or one of
    its lookalikes that survive NFKC, U+16EB `᛫`, U+2022 `•`, U+2024 `․`, U+2027 `‧`, U+2219 `∙`, U+22C5 `⋅`, U+2E31 `⸱`, U+30FB `・` (U+FF65 normalises
    to it), gets `approval_card_not_minimal` (commas stay allowed);
  - an item or option name holding U+23CE `⏎` or any character of U+2190-U+21FF (Arrows), U+2400-U+243F
    (Control Pictures), U+2794-U+27BF (Dingbat arrows), U+27F0-U+27FF and U+2900-U+297F (Supplemental Arrows),
    U+2B00-U+2BFF (Misc Symbols and Arrows), U+1F800-U+1F8FF (Supplemental Arrows-C) gets `approval_card_not_minimal` (e.g. `↵`, and the halfwidth `￩` that normalises into the block).
- A pickup location's name must not start like the delivery form: NFKC-normalise, collapse runs of U+0020 to one,
  drop leading U+0020, lowercase ASCII A-Z, then refuse a `delivery to` prefix (`approval_card_not_minimal`).
  The delivery address and the display name get no extra rule (each is its own row).

## Every field the merchant receives (review-b L17768; app main forkicks.ts, forkicks-schema.ts)

The app sends the merchant two requests. Every field is quoted on the card, derived from a quoted row, or fixed by
the resident's identity, except the note (known gap, Carter L17772).

| Request (app) | Field | On the flat card |
|---|---|---|
| quote, at prepare (`POST /api/agent/orders/quote`, forkicks.ts:62; body = `ForKicksOrderInput` (strict) + 2) | `items[].itemId`, `items[].optionIds`, `items[].qty` | Order row: the merchant's quote lines (name, options, qty) for exactly these items; ids must equal the line's ids (box check) |
| | `fulfilment.type` | Pickup row (`<place>` or `Delivery to <address>`) |
| | `fulfilment.locationId` | derived: must equal the quote location's id (box check), whose name is on the Pickup row |
| | `fulfilment.date` | Pickup row (the date; when absent, the location's opening day the merchant quoted) |
| | `fulfilment.deliveryAddress` | agent-written free text: a delivery order gets the technical card today (review-b ov#446 S1); refused on a pickup |
| | `paymentMethod` | Total row (`pay by UPI` / `card at pickup`) |
| | `note` | NOT on the card: known gap accepted by Carter (lead L17772); in Full details only |
| | `customerRef` | derived: the app's pseudonymous id for this resident (`customerRef(tenantId, humanId)`), never agent text |
| | `agentOrder` | constant `true` |
| create, after approval (`POST /api/agent/orders`, forkicks.ts:171-174) | `quoteId` | derived: the merchant's quote for exactly the fields above, held in the app's saved draft (its lines, total and place are the quoted rows) |
| | `idempotencyKey` | the draftId: bound (one approval key per draftId) |
| | `customer.ref` | as `customerRef` |
| | `customer.displayName` | Name row |

The quote request reaches the merchant at prepare, BEFORE the approval. It places nothing: only the create after
the grant places the order. If the app ever adds a field to either body, it must add a row here and a check in all
three implementations, or send the legacy shape.

## Order of the checks (so the three implementations return the same code)

1. Today's technical-card checks (`approval_summary` / `forkicksSummary`): `approval_card_invalid`.
2. What-you-see table above (unshown fulfilment key, delivery address on a pickup, location id, item ids):
   `approval_card_invalid`.
3. Build the strings; a bad month/day is `approval_card_invalid`.
4. A delivery order (pickup only today), the pickup place's `delivery to` prefix, a `·` in the place or address, a line-mark character in an item or
   option name: `approval_card_not_minimal`.
5. The budget on each of the four values: `approval_card_not_minimal`.

## The minimal-card budget (never cut a purchase)

approval-md 0.4.7 `telegram-minimal`: a quoted value is cut past `MINIMAL_QUOTE_MAX` = 280 code points, two
of which are the runtime's isolate marks, and some characters are drawn as `«U+XXXX»` marks. So each of the four
strings must be:

- 1 to 278 code points long, counting each U+000A of the Order row as 3 (core draws it as ` ⏎ `) (NOT 280: core draws a value inside two isolate marks and counts them, so a 279- or
  280-code-point value is already cut; the vectors pin 278 fits, 279/280/281 do not, and the core test proves the
  cut at 279 and 280 through approval-md 0.4.7); and
- made only of U+0020 spaces, letters, numbers, punctuation and symbols (Unicode general categories L, N, P, S)
  other than `«` U+00AB, `⏎` U+23CE, U+115F, U+1160, U+3164, U+FFA0, U+2800; and combining marks (category M)
  other than the default-ignorable U+034F, U+17B4, U+17B5, U+180B-U+180F, U+FE00-U+FE0F, U+E0100-U+E01EF, at
  most 2 in a row; and, in the Order row only, the U+000A between lines.

Otherwise the formatter refuses with `approval_card_not_minimal` and the app sends the legacy shape FOR THAT DRAFT
(prepare's payload, payload_hash and confirm all use the legacy shape; the box accepts it as today). The say entry
below quotes only the four keys, so core sends a legacy payload the technical card (fallback `unlisted-key`:
`appId`, `operation`, `preview` are not in the map): every line and price, never cut. A four-key payload that breaks the
budget is refused by the box. The rule is conservative: anything it refuses that core would have drawn whole
only costs a technical card.

## The card (the control plane's template; the overlay mirror follows it)

```yaml
        marketplace.app.action:
          does: "place an order with For Kicks for you"
          quote: { order: "Order", total: "Total", pickup: "Pickup", name: "Name shared with café" }
          note: none
```

Labels CONFIRMED (product + lead L17744). Core 0.4.7 refuses a label over 24 characters (`PROMPT_SAY_LABEL_MAX`,
`prompt-say-label`): the first wording "Name shared with the café" (25) would have failed the whole policy load;
"Name shared with café" is 21. The `does` phrase now names For Kicks for every card of the parent class; today For Kicks
is the only app that asks under it (a Gold Star send runs on its own member class; a legacy-shaped request of
any app gets the technical card, `unlisted-key`), so **approval-confirm** before a second app asks under it.
