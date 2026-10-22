# Railway status watcher

Ops tooling, not part of the overlay a box installs (CLAIMS L18050, L18092).
Every box clones this whole repo at its tag, so these files sit on box disks
too, but nothing on a box runs them and they hold no secret: the Telegram
variables come only from the workflow's environment.

## What it watches

`.github/workflows/railway-status-notify.yml` runs every five minutes on
GitHub, outside Railway, so it still speaks when Railway is down (GitHub may
start a scheduled run some minutes late). It reads status.railway.com's own
JSON feed, `https://status.railway.com/api/status` (`activeIncidents`,
`recentIncidents`: id, slug, title, status, components, updates), and posts
ONE plain-text message to the operator group per change: a new incident, or an
incident whose status moved (investigating, identified, monitoring,
resolved). The message has the title, status, affected components, the latest
update and the link:

```
Railway incident NEW: investigating
Builds are temporarily paused
Components: Builds: US West (California, USA), EU West (Amsterdam, Netherlands), Southeast Asia (Singapore), US East (Virginia, USA) [partial outage]
Latest update: We are currently investigating this issue
Started 2026-10-21 07:24 UTC, updated 2026-10-21 07:24 UTC
https://status.railway.com/incident/QH8L8B3E
```

A further update with the same status sends nothing. A late run may combine
changes: investigating, identified and monitoring between two runs arrive as
one `monitoring (was investigating)`.

## Secrets (Carter adds them on Edge-City/agentvillage)

Repository secrets, the same names and values as the alerts notifier on
agentvillage-data's `ingest`:

- `ALERTS_TELEGRAM_BOT_TOKEN`
- `ALERTS_TELEGRAM_CHAT_ID`
- `ALERTS_TELEGRAM_THREAD_ID` (optional: the alerts topic; unset is General)

**Merge only after the secrets are set.** Without them every scheduled run
fails (exit 2, naming the variables, never their values) and GitHub emails
each failure.

## State

The Actions cache (`railway-status-state-*`): the newest entry is restored,
and a new one is saved only when something changed, and only on `main`. It
holds only public data: Railway incident ids, statuses and update times. The
cache of a public repo is readable only by this repo's workflows. No state
(the first run, or the cache evicted after seven days without access) records
every incident and posts only the unresolved ones, so old resolved incidents
are never replayed.

## Failures

- **Feed** unreachable, not JSON, either incident list missing or not an
  array, or ANY incident missing its id, title, status or created time (a
  renamed field in this undocumented feed): the run fails (exit 1), nothing is
  sent, the state is unchanged. One malformed incident keeps every run red
  until Railway fixes it or it leaves the feed; that is on purpose (loud
  rather than silently blind).
- **Telegram** refusing one message for its content (a 400 saying it is too
  long, not UTF-8, empty, or has entities it cannot parse): logged as
  `railway_status.send_refused`, recorded as done so it never blocks later
  alerts, the rest are sent, the run exits 1.
- **Telegram** anything else (unreachable, 429, 5xx, a 400 we do not
  recognise or with no body, a migrated supergroup, missing rights, 401, 403,
  404, 409): what was sent is kept and the rest go on the next run (exit 1).
- Logs carry codes, incident slugs and counts only: never the token, the chat
  or thread id, the feed body or Telegram's reply. The logs of a public repo's
  Actions are public. Feed values in a log line (incident slug or id,
  status) are shown only when plainly safe (letters, digits, `_`, `-`), else
  as `invalid`, so a crafted value can never start a `::` workflow command.
  A dry run also prints the messages it would send (Railway's own public
  incident text), every line behind `| ` for the same reason.
- The job runs only in `Edge-City/agentvillage` (`if: github.repository`), so
  a fork's inherited schedule never runs it.
- Delivery is **at least once**, not exactly once: a send whose answer times
  out, or a lost cache entry (which re-seeds and re-posts what is open), can
  repeat a message.

A failed run shows in the Actions tab; GitHub emails whoever last changed the
workflow's schedule.

## Dry run

Prints what would be sent now; needs no secret; saves nothing.

- On GitHub: Actions, `railway-status-notify`, Run workflow, tick `dry_run`.
  A run from any branch other than `main` is always a dry run.
- Locally: `bun .github/railway-status/railway-status-notify.ts --state /tmp/railway-status.json --dry-run`
  (a missing state file is a first run, so it prints the open incidents).

## Silence it

`gh workflow disable railway-status-notify.yml -R Edge-City/agentvillage`, and
`gh workflow enable ...` to bring it back. Off for more than a week, the cache
is gone and the first run posts only what is open. GitHub also disables a
public repo's scheduled workflows by itself after 60 days without repository
activity; re-enable it the same way.

## Tests

From the repository root:

```
bun test ./.github/railway-status/railway-status-notify.test.ts
```

Pure: injected fetch, in-memory state, the trimmed live fixture in
`fixtures/`; it also parses the workflow file and pins its public-repo
invariants (triggers, permissions, no expression in a `run:` line, secrets
only in the notify step, main-only send and save, the fork guard, pinned
SHAs). **CI does not run it**: it is outside the overlay's test directories
(`.github/workflows/test.yml`'s `bun test` list) on purpose, so run it by hand
before merging any change to the script or the workflow.
