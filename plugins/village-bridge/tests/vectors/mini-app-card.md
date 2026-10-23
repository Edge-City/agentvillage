# Mini-apps generic approval card: the formatter spec

Mini-apps v2 Phase 1 item 6 (design `MINIAPPS-PLATFORM-v2-design.md` section 3). A `needs-card` operation of any catalog
app gets the For Kicks minimal card: four plain strings, each drawn whole and unmarked, or no card at all. Three codebases
build or check the same four strings, so this file is the one spec and `mini-app-card.json` (next to it) is the golden
vector set. The app and the control plane copy the JSON byte for byte into their own tests and must produce the same
output for every vector.

Implementations: the box `plugins/village-bridge/_mini_app_card.py` `card_fields` (For Kicks' `card_value_fits`
imported from `_forkicks.py`), the control plane `mini-apps-approval.js` `cardFields` / `cardSummary` (cp#352), the
app `drafts.ts` `cardFields`. The cp lane's 23 cases (`mini-app-card.cp-cases.json`) are included as the `cp: ` vectors.
This file is the one source (CARD-COMMON amendment 14:00Z): the cp and app twins reconcile to it. At cp#352 head
eeb0e6c3 the cp's own `cardFields` agrees with every vector except the six per-value ones restored by the amendment
(spaces only x2, U+21B5 x2, U+FFE9, U+2424), which it still accepts.
For Kicks' own card (`forkicks-approval-card.{md,json}`) is unchanged this train; its preview is re-expressed here through
a declaration (two vectors), so one engine renders both (a multi-line For Kicks order does not fit the generic card).

## Input

- `declaration`: the needs-card op's manifest `approval.card`, exactly
  `{ "item": <path>, "total": <path>, "when": <path>, "shared": <path>, "bind": [[<requestPath>, <previewPath>], ...] }`.
  `bind` is required (it may be empty) and holds at most 32 pairs.
- `preview`: the prepare op's preview (the object the app stores and returns beside the payload).
- `request` (optional): the prepare op's arguments, as the box sent them. When given, every `bind` pair is checked for
  equality. The control plane has no request and passes none; the app and the box pass it.

A **path** is 1 to 8 segments joined by `.`, each segment `[A-Za-z_][A-Za-z0-9_]{0,63}`. No `$.` prefix, no array
index, no wildcard. A path walks objects only.

**Platform keys.** The top-level preview keys `appId`, `operation` and `draftId` (the app, the needs-card op and the
draft, bound by the approval key `...:<draftId>` itself) are never shown or bound by a declaration, and the shown-or-bound
walk skips them. Their values are the caller's check (the box and the cp: equal to the app, op and draft confirmed).

## Output

- `card`: exactly `{item, total, when, shared}`, each the string at its declared path, verbatim.
- `payloadHash`: sha256 (lowercase hex) of the canonical JSON of `card`: keys sorted, no whitespace
  (`","` and `":"`), UTF-8, non-ASCII characters written as themselves (Python `ensure_ascii=False`, JavaScript
  `JSON.stringify` of the sorted object).
- `summary`: the text proposed beside the payload (`--summary`; the technical card's "Full details"), exactly
  `What: <item>` U+000A `Total: <total>` U+000A `When & where: <when>` U+000A `Shared with: <shared>` (the cp checks these
  bytes). Over 4096 UTF-8 bytes, or over 3000 once `&`, `<`, `>` are escaped as `&amp;`, `&lt;`, `&gt;` (For Kicks'
  budget): `summaryError: approval_card_too_long` (the strings are fine; the card is still refused). The labels are
  approval's (L19771); the card's own row labels live in the cp policy template's say entry (approval's commit).
- or `error`: one of the codes below.

## The checks, in order (so the three implementations return the same code)

1. **Declaration.** Not an object, not exactly the five keys, a path that is not a path, a `bind` that is not a list of at
   most 32 pairs of paths, a shown or bound preview path in a platform key, two shown paths equal, or one shown path a
   segment prefix of another: `approval_card_invalid`. (The cp's manifest validator refuses all of these statically,
   `card_path_reused` / `card_path_reserved` / `card_bind_reused`, so a served declaration never has them; the box keeps
   the checks. A missing declaration is the caller's `approval_card_undeclared`, never a vector.)
2. **Preview** is not an object: `approval_card_invalid`.
3. **Shown or bound** (design 3.2; review-a S1 on cp#286), the cp's walk: for each top-level key except the platform
   keys, the key must be a segment, and its value must be covered: a path equal to a shown path or to a bound
   `previewPath` is covered (a bound path covers its whole subtree); otherwise a non-empty object is descended, and
   anything else (string, number, boolean, null, list, empty object), or an object 8 deep, is refused. Every key on the
   way must be a segment. Refused: `approval_card_invalid`.
4. **Shown paths.** Each of the four resolves (every segment an existing key of an object) to a string. A missing
   segment, a walk through a non-object, or a non-string value: `approval_card_invalid`.
5. **Bind**, only with a `request` (the app and the box; vectors marked `requestOnly`): each pair's two sides resolve and
   are equal as canonical JSON (`2` differs from `"2"`, `true` from `1`). Otherwise `approval_card_invalid`. Without a
   request (the cp) nothing is checked here: the app enforced it at prepare.
6. **Every For Kicks per-value rule, on EACH of the four strings** (CARD-COMMON amendment 14:00Z; For Kicks'
   `card_value_fits` and `card_name_fakes_line`, approval-md 0.4.7 `telegram-minimal`):
   - 1 to 278 code points of U+0020 spaces, letters, numbers, punctuation and symbols other than `«` U+00AB, `⏎` U+23CE,
     U+115F, U+1160, U+3164, U+FFA0, U+2800, and combining marks other than the default-ignorable ones, at most 2 in a
     row, with NO line break (so U+000A, any control or format character, a no-break space are refused);
   - not blank (not only U+0020 spaces);
   - no character that draws like core's line mark after NFKC: U+23CE and the blocks U+2190-U+21FF, U+2400-U+243F,
     U+2794-U+27BF, U+27F0-U+27FF, U+2900-U+297F, U+2B00-U+2BFF, U+1F800-U+1F8FF (e.g. `↵` U+21B5, halfwidth `￩` U+FFE9).
   Otherwise `approval_card_not_minimal`. A string that does not fit is never cut, and a generic app has NO
   technical-card fallback (no legacy shape): nothing runs.
7. **Summary budget** (separate: `card_summary` / `cardSummary`): `approval_card_too_long`.

Not in this rule set: For Kicks' Pickup-row folds (a `·` lookalike in a place, a `delivery to` prefix), which belong to
its own row format.

## What the codes mean downstream

- The app (prepare): a refusal means no draft is stored and the resident sees no card; the agent gets the code.
- The box: re-derives the four strings from the preview with the declaration its projection entry carries
  (`approval: {prepare, card, fields, bind}`) and refuses any difference (`approval_card_invalid`), as For Kicks does;
  no declaration = `approval_card_undeclared`, never proposed. It refuses before any propose.
- The control plane (`request()`): any refusal is a refused approval request.

## Card class and key (CARD-COMMON item 3)

The parent `marketplace.app.action` is autonomous for everyone. A generic needs-card op proposes under its MEMBER class
`marketplace.app.action.<operation>`, where `<operation>` is the op's full name and its first segment is the app id
(e.g. `marketplace.app.action.acme.rental.confirm`; the same shape as the `marketplace.app.action.gold-stars.send` member
row), with key `<class>:<draftId>`; payload = the canonical `card`, summary = `summary`. The daemon must answer `requested`
(a member row approval pinned to ask); `autonomous` (no member row yet) is refused `approval_card_unpinned` and nothing
runs. The box sends the app `{taskId, payloadHash, payload, preview}` (the preview beside the payload), the cp's body.

## Vectors

`vectors[]`: `{name, declaration, preview, request?, requestOnly?, card, payloadHash, summary | summaryError}` or
`{name, declaration, preview, request?, requestOnly?, error}`. `requestOnly`: the outcome needs the request; an
implementation that has none (the cp) skips the vector. `platformKeys` lists the skipped preview keys. Vectors are
Unicode-version-neutral (no code point newer than Unicode 14), as For Kicks' are. All data is invented.
