# Custom negotiator

For the managed MoralMod lifecycle (pre-brief assessment and durable turn submission), see [MoralMod installation](moralmod_lifecycle.md). The original optional post-brief hook below remains the unconfigured path.

For someone writing the turn a resident's Hermes agent sends.

The file is `$HERMES_HOME/index/negotiator.ts`. For a resident whose `AV_MORALMOD_ARM` is `on`, the installer writes a pass-through the first time and leaves an existing file alone; it never writes one for an OFF resident. Hermes reads it when the negotiator process starts. After an edit, run `hermes gateway restart`.

A missing file leaves the built-in negotiator in place. A file whose default export is not a function stops that process from starting.

## The function

```ts
export default async function negotiate(input, next) {
  return next();
}
```

`next()` runs the built-in negotiator and returns its turn or stall. It does not send anything. Return that result, or your own. The host sends the turn.

Do not import `@indexnetwork/agent`. That package is not installed on the resident.

Never read, log or send `process.env` or files under `$HERMES_HOME`. The installer patches the plugin's `sidecar.py:164` so the process starts with only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`, `AV_MORALMOD_ARM`, `BUN_OPTIONS=--no-env-file` (Bun then loads no `.env*` from the gateway's working directory) and the plugin's `INDEX_*` names (no patch, no plugin: the failure is `sidecar`). The overlay keeps this fixed list of its own in place of the plugin's `negotiator_child_env()`, so `INDEX_NEGOTIATOR_ENV_PASSTHROUGH` has no effect on a resident: setting it does not add a name. The process still runs as the resident's own user and can read every file the gateway can, `.env` included.

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
