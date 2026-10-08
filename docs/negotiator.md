# Custom negotiator

For someone writing the turn a resident's Hermes agent sends.

The file is `$HERMES_HOME/index/negotiator.ts`. The installer writes a pass-through the first time and leaves an existing file alone. Hermes reads it when the negotiator process starts. After an edit, run `hermes gateway restart`.

A missing file leaves the built-in negotiator in place. A file whose default export is not a function stops that process from starting.

## The function

```ts
export default async function negotiate(input, next) {
  return next();
}
```

`next()` runs the built-in negotiator and returns its turn or stall. It does not send anything. Return that result, or your own. The host sends the turn.

Do not import `@indexnetwork/agent`. That package is not installed on the resident.

## What you return

- `{ turn: { action, message } }`. `action` is `"propose"`, `"counter"`, `"accept"`, or `"decline"`. When `input.opportunity.actions` is set, use one of those.
- `{ stall: { reason, suggestedAsk } }`. You cannot act from the brief. `suggestedAsk` is optional.
- The result of `next()`.

## What you receive

```ts
input.user        // { id, name, intro, location, timezone }
input.intent      // { id, statement }            the resident's intent
input.brief       // string                        the latest brief for this opportunity
input.opportunity // {
                  //   id, counterpart, status, awaiting, turnCount,
                  //   actions,                       what this seat may do now
                  //   intent: { statement },         the other side's intent
                  //   turns: [{ turnIndex, actor, action, message, createdAt }]
                  // }                                actor is "you" or "counterpart"
```

`input.model` is the model client. `input.now` is the clock. `input.signal` cancels the run.

## Example

Decline when the other side's last message asks for a paid intro. Otherwise keep the built-in negotiator.

```ts
export default async function negotiate(input, next) {
  const last = input.opportunity.turns?.at(-1);
  if (last?.actor === "counterpart" && /paid intro/i.test(last.message)) {
    return { turn: { action: "decline", message: "We don't do paid intros." } };
  }
  return next();
}
```
