# Per-job delivery settings, add-from-template and the team-only preview (J2, overlay half)

Status: **as built**, 2026-10-05, for rc14, after review fix round 1. This is the contract the
control-plane half is built against: a control-plane lane should need nothing else. Hermes
references are to `~/.hermes/hermes-agent` at tag `v2026.9.24`; croniter references are to croniter
6.0.0, the version that Hermes tag pins. Overlay line numbers are at this PR's tip.

## What changed

On rc13 the six proactive jobs ran on constants. Their schedules were already per tenant: Hermes
keeps them, and reconcile never touches a custom one. But the brief's delivery window was fixed at
05:00 to 11:00 Asia/Kolkata, and no other job had a window. A job could not be added for one
tenant, and nothing could be tried out without waiting for its slot. Now:

- each agent job reads its window and zone from one per-tenant file at run time, and rc13's
  constants are the defaults;
- the control plane changes a job with one command inside the tenant: schedule, window, zone,
  enabled;
- a job can be added for one tenant from three templates, and removed again;
- a team tenant can preview any job's message now, and the preview consumes nothing.

A tenant with no settings file runs exactly as on rc13 (§7).

## 1. The carrier: `$HERMES_HOME/av-events/job-settings.json`

**Why a file.** Hermes runs a pre-run script as a bare path, with no arguments and no
per-job environment. `cron/scheduler_script.py` `_script_argv` (line 303) builds `[bash, path]`,
and `_resolve_script_path` (line 257) requires the script to sit under `$HERMES_HOME/scripts/`. A
job record has no `env` field (`hermes_cli/cron.py` `_JOB_ARG_FIELDS`, line 670). So arguments
and environment on the entry are not possible, and a file is the only carrier. A file also meets
the other two tests. The control plane changes it with one non-interactive command
(`install/jobs.ts set`), with no roll. And reconcile never writes it, so a roll cannot undo it (§4).

**Schema** (`skills/index-network/scripts/job-settings.ts`):

```json
{"v": 1, "jobs": {"brief": {"window": "06:30-09:00", "tz": "Asia/Kolkata"}, "tpl-digest-preview": {"window": "16:00-18:30"}}, "adminSchedules": ["brief"]}
```

| Field | Rule | Default when absent |
| --- | --- | --- |
| `v` | exactly the number `1` (§10.8) | (required) |
| `jobs` | an object keyed by job key | `{}` |
| `jobs.<key>.window` | `HH:MM-HH:MM`, 24-hour, two digits each; start inclusive, end exclusive; start after end runs across midnight; start equal to end is invalid | the job's default window |
| `jobs.<key>.tz` | an IANA zone (rules in §3) | `Asia/Kolkata` |
| `adminSchedules` | a list of default job keys whose schedule an admin set with `set --schedule` | `[]` |

**Job keys.** The five default agent jobs are `brief`, `drop-midday`, `drop-evening`,
`negotiation` and `evening`. The three template jobs are `tpl-brief`, `tpl-digest-preview` and
`tpl-evening-ask`. The prefetch has no settings, because it delivers nothing.

**Defaults** (`DEFAULT_WINDOWS`, job-settings.ts:65):

- `brief` and `tpl-brief`: 05:00 to 11:00, which is rc13's brief window.
- Every other job: no window. It delivers whenever its schedule runs it, as on rc13.

**Overrides only.** `jobs` holds overrides and nothing else:

- `set --window default` and `set --tz default` remove that field. They never write the default's
  value, so a fleet change to a default reaches every job without an override (§4).
- An entry left with no field is deleted. A job with no entry has `settings: "default"` in `list`.
- A file left with no entry and no admin schedule is removed. The tenant is then back to no
  settings file, exactly as on rc13 (`list` says `settings: "absent"`).
- A command that would leave the file's bytes unchanged writes nothing (`changed` has no
  `"settings"`).

**Admin-managed.** A default job is admin-managed when it has an entry in `jobs`, or its key is in
`adminSchedules`. Reconcile's legacy schedule migration (§4) never moves an admin-managed job.

- `set --schedule` on a default job adds its key to `adminSchedules`.
- That mark is kept when its window and zone are cleared. So a job whose only customisation is its
  schedule stays exempt from the migration.
- Nothing removes the mark except removing the file. It matters only for a job whose schedule is
  the old synchronized default, which is the one schedule the migration moves.
- The trigger never reads `adminSchedules`. A malformed value (not a list of default job keys)
  counts every default job as admin-managed. The command that next writes the file keeps only the
  valid keys, and reports `"dropped": [..., "adminSchedules"]`.

**Not in the file.**

- **The schedule.** Hermes's job record holds it, and it is the only place Hermes reads one.
- **Enabled.** This is Hermes's pause state (`cron/jobs.py` `is_job_runnable`, line 521), which
  reconcile already keeps. There is one source of truth, and nothing was added for it.

**Written only by `install/jobs.ts`**, holding the jobs lock (§2). The write goes to a temp file
then a rename, mode 0600, in a 0700 directory (`replaceSettingsFile`, job-settings.ts:525). **The
control plane never writes this file directly**, not even to repair it. It changes it only through
the commands, which validate every value and keep the other jobs' entries.

## 2. Commands the control plane runs inside a tenant

Run each command from the overlay checkout, with the same `HERMES_HOME` and user as the installer.
Pass every value as its own argv element, never through `sh -c`.

**Output.** Every command prints **exactly one line of JSON on stdout**:
`{"ok":true,...}` or `{"ok":false,"error":"<code>",...}`. Nothing in that line is free text from
the tenant: ids, schedules, zones and windows are printed only after they pass their grammar
(§3), and the settings file's problems appear only as codes. Hermes's own output goes to stderr.
Treat stderr as untrusted diagnostics from the tenant. Never parse it, and never hand it to a
model.

**Bounds.** Each flag may appear once, and only the command's own flags are accepted. Every value
is at most 200 characters (`MAX_ARG_CHARS`, jobs.ts:105); a longer one is refused as
`missing-value`. A schedule is also at most 100 characters (§3). `--allow-frequent` is a switch
with no value, and is accepted only alongside `--schedule`.

**The lock.** `set`, `add`, `remove` and `preview` each run holding one exclusive lock per tenant,
`$HERMES_HOME/av-events/jobs.lock`.

- It is the state lock's file format and stale rule (`tryAcquireLock`,
  `skills/index-network/scripts/state-lock.ts`). The lock file is created with `O_EXCL` and holds
  a token. A lock older than 150 s, or dated more than 150 s in the future, belongs to a killed
  command and is taken over.
- A second command while one runs gets `busy` at once, exit 4, and nothing changes. It is safe to
  retry after a short delay.
- A command killed mid-way (a control-plane timeout) leaves the lock. Others then get `busy` for at
  most 150 s.
- Grammar refusals are answered before the lock is taken, so a malformed request is never told
  `busy`. `list` takes no lock.
- Reconcile does not take this lock. The control plane's own per-tenant lease must keep job
  commands and rolls apart (§10.6).

**Exit codes.**

| Exit | Meaning | What the caller does |
| --- | --- | --- |
| 0 | Done. | Nothing. Read `changed` and any `warning`. |
| 1 | A step failed part-way. `applied` lists what stays changed. | **Not a plain retry.** Run `list`, compare it with the desired state, and re-issue the command once; the commands are idempotent. If the same code comes back, stop and alert a person. The per-code notes below override this. |
| 2 | Refused before anything changed. | Do not retry the same input. Fix the input, or the tenant, as the code says. |
| 3 | `preview` refused: not a team tenant. | Do not retry. |
| 4 | `busy`: another job command holds the lock. Nothing changed. | Retry after a few seconds, a bounded number of times. |

Hermes's CLI exits 1 for every failure, transient or not, so the tool cannot tell a failure
worth retrying from one that is not. That is why exit 1 means "read back first", not "retry".

**Refusal and failure codes.**

| Code | Exit | Extra fields | When | Retry? |
| --- | --- | --- | --- | --- |
| `unknown-command`, `unknown-flag` | 2 | | not one of the five commands, or a flag the command does not take | no |
| `duplicate-flag`, `missing-value` | 2 | `flag` | a flag twice; a flag with no value, or a value over 200 characters | no |
| `missing-flag` | 2 | `flag` | a required flag absent, or `--allow-frequent` without `--schedule` | no |
| `nothing-to-set` | 2 | | `set` with no change flag | no |
| `invalid-job`, `invalid-template` | 2 | | not a job key / template name | no |
| `invalid-schedule` | 2 | | outside the schedule grammar (§3) | no |
| `invalid-window`, `invalid-tz`, `invalid-enabled` | 2 | | outside its grammar; `add` also refuses `default` | no |
| `schedule-never-fires` | 2 | | no run at all: croniter's impossible dates, or 29 February alone (§3) | no |
| `schedule-frequent` | 2 | | fires more than once in some hour, without `--allow-frequent` | only with `--allow-frequent`, if meant |
| `schedule-outside-window` | 2 | `schedule`, `window`, `tz` | no run lands in the window on any day of the coming year (§3) | no |
| `hermes-zone-unknown` | 2 | | a window check is needed, and Hermes's zone is unset, not a zone Hermes accepts, or set to two different zones (§3) | after the tenant's zone is fixed (a roll sets it) |
| `job-not-installed` | 2 | `job` | no Hermes job by that name: a default job needs a roll; a template job needs `add` | no |
| `job-ambiguous` | 2 | `job`, `count` | two or more Hermes jobs carry the name | no; a person removes the extra one |
| `job-unreadable` | 2 | `job` | a job by that name has an id that is not Hermes's (`^[0-9a-f]{12}$`). Nothing is acted on, and the id is never passed to Hermes or printed. For `preview` the job is `"preview"`. | no; a person looks (a roll removes a retired or preview name) |
| `not-team-tenant` | 3 | | `preview` on a tenant without `AV_TEAM_TENANT=1` (§5) | no |
| `busy` | 4 | | the jobs lock is held | **yes** |
| `hermes-failed` | 1 | `step`, `applied`; `removed` (remove), `resumeMayFire` (reanchor) | a Hermes command exited non-zero. `step` is one of `schedule`, `enabled`, `reanchor`, `create`, `edit`, `remove`, `remove-previous`. | read back, then once |
| `hermes-unavailable` | 1 | `applied: []` | the Hermes CLI does not run. Nothing changed. | yes, later (a restart may be in progress) |
| `settings-write-failed` | 1 | `applied` | the settings file could not be written | read back, then once |
| `prompt-missing`, `shim-missing` | 1 | `applied: []` | the overlay's prompt or shim is not installed. Nothing changed. | after a roll |
| `job-not-found-after-create` | 1 | `applied` | Hermes said it created the job, but no new job with a valid id is in `jobs.json` | no; alert |
| `schedule-readback-mismatch` | 1 | `applied` | after the edit or create, Hermes holds a schedule other than the canonical form sent | no; alert |
| `fault` | 1 | `applied` | an unexpected error (a bug) | no; alert |

`applied` is accurate on every failure, `fault` included. If Hermes exits non-zero after it saved
the change, the tool reads `jobs.json` back, and `applied` names that step too.

### `list`

`bun install/jobs.ts list` is read-only and takes no lock.

```json
{"ok":true,"settings":"absent"|"ok"|"invalid:<code>","jobs":[{...}],"missing":["<default key>"],"unreadable":["<key>"]}
```

| Field | Meaning |
| --- | --- |
| `settings` | the file's state: absent, valid, or refused whole with a file code (§3) |
| `jobs[].key` | the job key |
| `jobs[].id` | the Hermes id (always 12 hex characters) |
| `jobs[].name` | the job's fixed Hermes name, from the overlay |
| `jobs[].schedule` | the stored schedule in canonical form, or `null` when it is not canonical (set by hand, or not a cron expression) |
| `jobs[].scheduleUnreadable` | `true` when `schedule` is `null` (absent otherwise) |
| `jobs[].enabled` | Hermes's pause state: `false` when paused |
| `jobs[].window` | the effective window `HH:MM-HH:MM`, or `null` for none |
| `jobs[].tz` | the effective window zone |
| `jobs[].settings` | `absent` (no file), `default` (no entry), `custom` (the entry is used) or `invalid:<code>` (`entry`, `window` or `tz`, or a file code) |
| `jobs[].adminSchedule` | `true` when the key is in `adminSchedules` |
| `missing` | default jobs with no Hermes job (a roll recreates them) |
| `unreadable` | keys whose Hermes job has an id outside Hermes's shape. These jobs are left out of `jobs`. |

Template jobs appear only when added. A key whose name has two jobs appears twice.

### `set`

```
bun install/jobs.ts set --job <key> [--schedule "<cron>" [--allow-frequent]] [--window HH:MM-HH:MM|default] [--tz <zone>|default] [--enabled true|false]
```

It refuses in this order: grammar, lock, job lookup, Hermes availability, the window check. Then
it runs three steps in order and stops at the first failure (`setCommand`, jobs.ts:527):

1. **The schedule**, if given and different from the stored one. It runs
   `hermes cron edit <id> --schedule <canonical>`, then reads the schedule back and compares it
   with the canonical form. The edit keeps the job's id and its pause state (`cron/jobs.py`
   `_apply_schedule_update`, line 1994). Hermes does not recompute the next run of a paused job
   (line 2002), so the next run stays stale until resume (below).
2. **The settings**, whenever `--schedule`, `--window` or `--tz` is given. The entry is merged:
   named fields are set or removed, other valid fields are kept, and invalid ones are dropped. An
   empty entry is deleted. `--schedule` on a default job adds its key to `adminSchedules`. Written
   only if the bytes change.
3. **Enabled**: `hermes cron pause|resume <id>`, only when the job's state differs. A pause or
   resume alone is never refused and needs no window check.

Success line:

```json
{"ok":true,"job","id","changed":[...],"schedule","enabled","window","tz", ...optional}
```

| Field | Meaning |
| --- | --- |
| `changed` | the steps that changed something, in order: `"schedule"`, `"settings"` (whenever the settings file's bytes changed: written, replaced or removed), `"enabled"` |
| `schedule` | the canonical schedule now in force, or `null` with `scheduleUnreadable: true` |
| `enabled`, `window`, `tz` | the state after the command |
| `check: "skipped"` | the job has a window, but its stored schedule is not canonical, so it could not be checked |
| `warning: "window-seasonal"`, `outsideFrom` | the schedule lands in the window on only some days of the year (§3). `outsideFrom` is the first such date, `YYYY-MM-DD` in the job's zone. |
| `frequent: true` | the schedule fires more than once in some hour (`--allow-frequent` was given) |
| `missedSlot: "dropped"` | a resume found a missed run, and re-anchored the next run so it does not fire (below) |
| `resumeMayFire: true` | a resume left a missed run due: the next Hermes tick may fire it (below) |
| `dropped` | names removed because they were invalid: `"window"`, `"tz"`, `"entry"` (the old entry was not an object) or `"adminSchedules"`. Present only when the file was written. |
| `replaced` | `invalid:<code>`: the file was unreadable and was replaced. Every other job's entries in it are gone; re-apply the desired state (§10.5). |

**Pause, resume and Hermes's catch-up.**

- `pause` keeps the job's stored next run (`cron/jobs.py` `pause_job`, :2067-2077).
- `resume` keeps a next run that already passed while the job was paused, as due
  (`resume_job`, :2080-2105). The next scheduler tick (every 60 s,
  `cron/scheduler_provider.py:416`) then fires it:
  - as "late" within the grace period, which is half the schedule's period clamped to 2 min to
    2 h (:926-932);
  - otherwise as a "catch-up" that fires once now, unless config.yaml sets
    `cron.catch_up_missed: false` (:3029-3035).
- So with Hermes's defaults, resuming a job that was paused across its slot sends at resume time,
  and a job with no window would deliver then.

**What `set --enabled true` does about it.** It reads the stored next run (`next_run_at`, by
Hermes's clock) before resuming.

- If that run is already due, the job has **no window**, and its stored schedule is canonical: it
  resumes, then re-applies the schedule (`hermes cron edit <id> --schedule <same>`).
  - Hermes recomputes the next run from now on a schedule edit of an unpaused job
    (`tools/cronjob_tools.py:837-842`; `cron/jobs.py:1994-2004`; `compute_next_run` with no last
    run, :1163-1172). It also drops any pending slot (:2054-2057).
  - So the missed run does not fire. The reply says `missedSlot: "dropped"`.
  - **Residual race:** the two Hermes commands are separate processes, about a second or two
    apart. A tick that falls between them can still fire the catch-up. Hermes v2026.9.24 has no
    atomic "resume without catch-up".
- If the job **has a window**, the catch-up is left alone, and the window gates it: it delivers
  at resume time only if that time is inside the window and the job has not delivered that
  village day. The reply says `resumeMayFire: true`.
- If the stored schedule is not canonical, the tool does not guess, and the reply says
  `resumeMayFire: true`.
- If the re-apply fails: exit 1, `step: "reanchor"`, `applied: ["enabled"]`,
  `resumeMayFire: true`. The catch-up will fire within a minute; there is nothing useful to retry.
- `--schedule` given in the same command as `--enabled true` on a paused job: the schedule is
  edited while paused, which leaves the next run stale. The resume then re-anchors to the new
  schedule (no window), or reports `resumeMayFire: true` (window).

The stand-in Hermes (`install/tests/fake_hermes.ts`) mirrors `next_run_at` on create, edit, pause
and resume, so the tests check the re-anchor end to end. It has no ticker, so the firing itself
rests on the Hermes lines cited above.

### `add`

```
bun install/jobs.ts add --template <brief|digest-preview|evening-ask> --schedule "<cron>" [--allow-frequent] [--window HH:MM-HH:MM] [--tz <zone>]
```

`add` creates the template's job, or brings an existing one to this schedule and shape
(`addCommand`, jobs.ts:640). It never creates two jobs. It refuses `default` for the window and
the zone.

1. **The settings first**, so the job never runs, not even once, without its window. They are
   merged as for `set`, and written only if the bytes change.
2. **The shim** under the template's name.
3. **The job.** It creates the job, reads its schedule back and records its id in
   `av-events/installed_jobs.json`. If the job already exists, it edits the shape (prompt,
   script, agent mode, failure target) if stale, then the schedule if different.
4. **On failure, the settings are rolled back.** If a Hermes step fails, or a fault happens before
   any Hermes change, the settings file is restored byte for byte, so no entry is left for a job
   that does not exist, and `applied` reflects the restore. If Hermes created the job and then
   exited non-zero, the entry stays and `applied` says `["settings","create"]`.

`add` **never resumes a paused template job.** It edits the schedule and shape only; use
`set --job tpl-<name> --enabled true`.

Success line:

```json
{"ok":true,"job":"tpl-<name>","id","result":"created"|"updated"|"unchanged","changed":[...],"schedule","window","tz", ...optional}
```

- `changed` holds `"settings"`, `"create"`, `"shape"` and `"schedule"`, as they happened.
- `result` is `unchanged` when `changed` is empty.
- The optional fields mean what they mean for `set`: `warning` and `outsideFrom`, `frequent`,
  `dropped`, and `replaced` (the last two only when the file was written).

### `remove`

```
bun install/jobs.ts remove --template <name>
```

`removeCommand`, jobs.ts:756, removes every job of that name, its ids in `installed_jobs.json`,
and its settings entry. An emptied file is removed. If the file is unreadable it is left alone.

```json
{"ok":true,"job":"tpl-<name>","result":"removed"|"absent","removed":<n>,"changed":["job"?,"settings"?]}
```

A failure part-way reports `removed`, the count already removed.

### `preview`

```
bun install/jobs.ts preview --job <key>
```

```json
{"ok":true,"job","id","fires":"in 1m"}
```

`id` is null if the new job could not be read back. A tenant that is not a team tenant gets exit 3,
`{"ok":false,"error":"not-team-tenant"}`, before the lock is taken and before anything is
created. See §5.

**Nothing reaches a shell.**

- Every value is matched against its grammar (§3) before use.
- Hermes is started with `execFileSync(bin, argv)`, and only with a job id of Hermes's shape.
- A template name selects one of three fixed specs; it is never interpolated into a path or a
  name.

## 3. Validation rules

### Schedule

`parseStrictCron`, job-settings.ts:213:

- Exactly five fields: minute, hour, day of month, month, day of week.
- Only `0-9 * , - /`, with **one space between fields** and none before or after. At most 100
  characters.
- Every number inside its field's range. Day of week is 0 (Sunday) to 6.
- `a-b` needs `b` above `a`. **A degenerate range `a-a` is refused, with or without a step**,
  because croniter reads it as the whole field (croniter.py:991). A reversed range is refused.
- `a/s` means from `a` to the field's maximum, every `s`.
- A step from 1 to the field's width.
- No names, `?`, `L`, `W`, `#`, `@daily`, intervals or Hermes phrases.

**Canonical form: the only form Hermes is ever sent.** Each field is written as its explicit
values joined by commas, and as `*` only when it holds every value. For example:

- `*/20 6-8 * * *` is sent as `0,20,40 6,7,8 * * *`.
- `0 23/2 * * *` is sent as `0 23 * * *`.

The reason is croniter 6.0.0, which normalizes `a/s` to `a-<max>/s` (croniter.py:924). When `a`
is the field's maximum, that becomes a degenerate range, read as `*/s`:

- `0 23/2 * * *` is every second hour to Hermes, not 23:00;
- `0 8 * * 6/7` is Sunday, not Saturday.

Explicit lists have no such reading. After every edit and create, the stored schedule is read
back and compared with the canonical form (`schedule-readback-mismatch` otherwise).

**Days.** A field that lists every value is `*`. So `1-31` is every day, and `0 8 1-31 * 1`
means Mondays only, which is also what croniter does with the canonical `0 8 * * 1`. When day of
month and day of week are both restricted, a day matches either. That is croniter's default
`day_or` (croniter.py:390), and Hermes uses the default.

**Differential test.** `skills/index-network/scripts/tests/fixtures/croniter-6.0.0.json` records
croniter 6.0.0's expansion of every expression in the reviewer's report and sweep. That covers
`a/s` for every start and step in all five fields, the maximum-value forms included, plus
degenerate, reversed and out-of-range cases, both accepted and refused. For each accepted
expression the test checks three things:

- the tool's value lists equal croniter's expansion of the canonical string;
- the tool's next five runs equal croniter's;
- "never fires" holds exactly where croniter raises.

Its generator sits beside it: `croniter-fixture-input.ts` and `croniter_fixture.py`, run once
with the Hermes venv's Python. The suite needs no Python.

**Never fires** (`cronNeverFires`, job-settings.ts:240; `cronLeapDayOnly`, :252). These are
refused as `schedule-never-fires`:

- A restricted day of month that none of the listed months has: `0 8 31 2 *`, `0 8 30 2 *`,
  `0 8 31 4,6,9,11 *`. This is refused whatever the day of week says, because croniter searches
  the day of month alone first and raises `CroniterBadDateError` (croniter.py:717). Hermes then
  refuses the schedule on create and edit (`compute_next_run`, `cron/jobs.py:1204`, surfaced by
  `tools/cronjob_tools.py:945`).
- 29 February alone (`0 8 29 2 *`). croniter accepts it, but it runs once in four years; the tool
  refuses it so that every accepted schedule fires within any year.

**Frequency floor** (`cronFrequent`, :261). A schedule with two or more minute values fires more
than once in some hour. `set` and `add` refuse it as `schedule-frequent` unless `--allow-frequent`
is passed; the reply then says `"frequent": true`. One minute value with several hours
(`30 16,17 * * *`) is not frequent.

### Window

`parseWindow`, job-settings.ts:83: `^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$`, with start
and end different. `24:00`, `5:00`, en dashes, spaces and a missing end are all refused.

### A job's zone (`tz`)

`isValidTimeZone`, job-settings.ts:127. Accepted:

- `UTC`;
- `Area/Location` or `Area/Region/Location`, in one of the ten geographic areas: Africa,
  America, Antarctica, Arctic, Asia, Atlantic, Australia, Europe, Indian, Pacific. The runtime's
  zone database must know the name, spelt exactly so.

**Backward links inside those areas are accepted**: `Asia/Calcutta`, `Europe/Kiev`,
`America/Buenos_Aires`. Refused: offsets, POSIX names (`EST5EDT`), `GMT`, `Etc/` and `US/` names,
and case variants. Bun's `Intl.supportedValuesOf("timeZone")` is the older CLDR list (it has
`Asia/Calcutta` but not `Asia/Kolkata`), so a name the database resolves to itself is accepted as
well.

### Hermes's zone

`hermesZone`, jobs.ts:402. Hermes reads every schedule in one zone per tenant, and it reads that
zone in two places.

- **Hermes's CLI** computes the next run on `cron create`, `edit` and `resume`
  (`hermes_time.py` `_resolve_timezone_name`, lines 83-106). It reads `HERMES_TIMEZONE` first,
  then `timezone` in config.yaml, else the host's local time. A `$HERMES_HOME/.env` value
  overrides the process environment (`hermes_cli/env_loader.py:434`).
- **The gateway**, whose ticker fires the jobs, copies config.yaml's `timezone` over
  `HERMES_TIMEZONE` at startup (`gateway/run.py:2087-2089`). So there config.yaml wins.

The tool therefore reads both: `HERMES_TIMEZONE` (the `.env` value, else the process
environment) and config.yaml's `timezone`. If they are set to different zones, the CLI and the
ticker would disagree, and the zone is unknown. Because a disagreement is refused, the order
between the two cannot change a result. The zone is also unknown when neither is set (Hermes
would use the host's local time), or when the name is not one Hermes accepts (it would log a
warning and fall back to local time).

An unknown zone is refused as `hermes-zone-unknown`, and only when a window check needs it. It is
never assumed to be Asia/Kolkata.

Accepted names are those Hermes's zoneinfo takes: `Asia/Kolkata`, `Asia/Calcutta`, `Etc/UTC`,
`Etc/GMT+5`, `US/Eastern`, `UTC`, `EST5EDT`. The name must use IANA capitalisation and be known to
this runtime's zone database (`isHermesZoneName`, jobs.ts:378). The installer sets config.yaml's
`timezone` to Asia/Kolkata (`install/config.ts` `configureVillageTimezone`).

### Schedule against window

`scheduleWindowFit`, job-settings.ts:364; `windowCheck`, jobs.ts:427. Whenever `set` or `add`
changes a job's schedule, window or zone and the job has a window, the schedule is checked
against the window. It is read in Hermes's zone, firing by firing, for **a full year** from now
(`WINDOW_CHECK_DAYS = 366`), so both DST changes of any zone fall inside the check. Only days on
which the schedule runs count (month, day of month, day of week). A day lands when at least one of
its firings is in the window, read in the job's zone.

| Result | The command |
| --- | --- |
| every day it runs lands | accepts |
| no firing ever lands | refuses `schedule-outside-window` |
| some days land and some do not (a DST change in either zone) | accepts with `"warning": "window-seasonal"` and `"outsideFrom": "YYYY-MM-DD"` (the first date, in the job's zone, on which nothing lands). Never silent. |

For example, `0 18 * * *` village time with window `08:00-09:00` America/New_York lands until
1 November (08:30 EDT), then not until March (07:30 EST): the reply is `window-seasonal`,
`outsideFrom: "2026-11-01"`.

A stored schedule that is not canonical cannot be checked; the reply then says
`"check":"skipped"`.

### Reading at run time

`readJobSettings` / `deliveryFor`, job-settings.ts:406 and :483. The read never throws, and it
never widens a window.

- **The file is refused whole** when it is not a regular file, is over 64 KiB, cannot be read, is
  not JSON, is not an object, has `v` other than `1`, or has `jobs` that is not an object.
- **One entry is refused** when it is not an object, or when its `window` or `tz` fails its rule.

Either way, the job falls back to its **default window** if it has one: the brief keeps 05:00 to
11:00 Asia/Kolkata. A job with **no default window is held silent** (`settings-invalid`), because
falling back to "no window" would mean all day. A bad zone never falls back silently to another
zone.

Unknown top-level keys, unknown job keys and unknown entry fields are ignored; the next command
that writes the file drops them.

## 4. What survives a roll

A roll runs `reconcileDigestCronJobs` (`install/install_index.ts`). It edits an existing job's
**shape** in place: prompt, script, agent mode and failure target (`staleShapeFields`, :487;
`cronEditArgs`, :471). Hermes keeps the id, the schedule, the pause state and the next run on an
edit (header, :28-34). Reconcile never writes `job-settings.json`. It reads it only to see which
jobs are admin-managed.

| What | Survives a roll? | Where |
| --- | --- | --- |
| A default job's custom schedule | yes, never compared | `scheduleStale`, install_index.ts:751 |
| A default job's schedule set by an admin to the old synchronized default (`0 8 * * *`) | yes: the job is admin-managed (an entry, or its key in `adminSchedules`, which `set --schedule` always writes) and skipped by the legacy migration | `adminManaged`, :679; used at :751 |
| The legacy migration for a job that is not admin-managed | unchanged from rc13 | :751 |
| An unreadable settings file, or a malformed `adminSchedules` | every default job counts as admin-managed | :679-685 |
| Pause state (enabled) | yes, `cron edit` keeps it | header :28-34; Hermes `cron/jobs.py:1994` |
| Window, zone and `adminSchedules` | yes, reconcile never writes the file | (no reference: reconcile has no write) |
| A template job (`Edge — template: <name>`, template still in `TEMPLATE_NAMES`) | kept, with its id, schedule and pause state; its shape is edited like a default job's; it is listed in `installed_jobs.json`; it is never created by reconcile | retire filter :694; template loop :715 |
| A job a resident created under exactly a template's name | **adopted**: reconcile treats it as the template job and rewrites its prompt and script | template loop :715 |
| A near-name of a template (`Edge — template: Brief`) or a retired template's job | removed, like any `Edge —` name that is not current, which is the existing prefix rule | :694 |
| A leftover `Edge — preview` job | removed, whatever its age; a roll in the minute before a preview fires cancels that preview | :694 |
| Preview state copies and preview shims older than an hour | removed | `prunePreviewFiles`, :687 |
| A fleet change to a prompt, a script or agent mode | still applied to every job, including admin-managed and template jobs | template loop and spec loop |
| A fleet change to a default window or zone | reaches every job without an override (defaults live in code, not the file) | `DEFAULT_WINDOWS`, job-settings.ts:65 |

Tests cover two consecutive rolls for all of these. They run end to end against a stand-in Hermes
that keeps `jobs.json`: `install/tests/job_commands.test.ts`, "what a roll keeps".

## 5. The preview, and how the team gate works

**The signal.** On rc13 the overlay cannot tell a team tenant from a resident. Team status
(`isTeam`, `AV_EMIT_IS_TEAM`) lives only in the control plane, derived from
`CONTROL_PLANE_TEAM_EMAILS`. This PR adds one variable that the tenant reads: `AV_TEAM_TENANT`
(`isTeamTenant`, job-settings.ts:559).

- The tenant is a team tenant only when the value is exactly `1` once surrounding whitespace is
  trimmed. Nothing else counts: no quote stripping, so `"1"` is refused, and so are `1 # team`,
  `true` and `01`.
- The value is read from the process environment if the variable is set there at all (even
  empty), else from the last assignment in `$HERMES_HOME/.env`, as python-dotenv reads it.
- Nothing in the overlay sets it. Until the control plane sets it, every preview is refused
  everywhere.

**Threat model.**

- **The resident.** The resident controls everything under `$HERMES_HOME`: `.env`, the overlay
  source and `jobs.json`. They can set the variable or delete the check. A preview only ever
  delivers to that tenant's own chat, with that tenant's own data, and consumes nothing. So
  against the resident the gate is meaningless, and also harmless.
- **The authoritative gate is the control plane's own team check**, made before it runs `preview`.
  `AV_TEAM_TENANT` is defence in depth: it stops a control-plane bug from previewing on a
  resident's tenant.

**Revocation lag.** The trigger runs as a child of the Hermes gateway. The gateway loaded `.env`
into its process environment at startup, with python-dotenv, which does strip quotes. The process
environment wins over `.env`. So:

- After the control plane removes `AV_TEAM_TENANT=1` from `.env`, `jobs.ts preview` refuses at
  once, because it runs in a fresh process that reads `.env`.
- But a preview job created before the removal still passes the trigger's gate until the next
  gateway restart.

Write exactly `AV_TEAM_TENANT=1`, with no quotes.

**Two gates.**

1. `jobs.ts preview` refuses (exit 3) before taking the lock or creating anything.
2. The trigger refuses too (`runPreview`, proactive.ts:838). A preview job that reaches a non-team
   tenant by any route stays silent (`preview-refused`): the model is never woken, so nothing is
   delivered.

**How a preview runs.** Hermes cannot pass a flag to a pre-run script (§1), and it cannot run a
paused job by hand (`tools/cronjob_tools.py` `_claim_for_manual_run`, line 184). It also forwards
a manual run to the gateway when delivery is relay-fronted (`_forward_relay_fronted_run`, line
124). So the preview is its own job:

- `preview` creates one Hermes **one-shot** job, `Edge — preview`, on schedule `in 1m` (Hermes
  `parse_schedule`, `cron/jobs.py:824-834`). After its single run Hermes marks it completed and
  keeps it (`_complete_job_record`, :1561-1563).
- The job delivers to telegram with failure target `local`.
- Its script is the shim under the name `agentvillage_proactive_preview-<key>.sh`, which runs
  `proactive.ts <key> --preview`.
- Its prompt is `PREVIEW_PREAMBLE` (jobs.ts:89) followed by the job's own prompt. The preamble
  tells the model to start the reply with the line `[TEST PREVIEW]`.
- Every earlier `Edge — preview` job is removed first, so there is one at a time.

**What a preview does not touch.** In the trigger, a preview:

- ignores the window and the day mark;
- **never takes the state lock**, so a real run is never delayed or silenced by it;
- reads the state file once, without the lock (every write of it is a rename), into a private
  copy under `av-events/proactive/preview-*/`;
- runs the content path against that copy. The copy is deleted afterwards, on the normal path and
  on the 100 s hard-deadline exit (`hardStopCleanup`, proactive.ts:817);
- applies no record, writes no day mark, stages no outcome ask, and clears no real stage
  (proactive.ts:703; tested: a seeded stage file is left byte for byte).

A preview before the real run, or after it, changes nothing the real run reads. The Script Output
is the real run's, and no message wording changed.

**What a preview can leave behind, and for how long.**

| Leftover | Present until |
| --- | --- |
| The last `Edge — preview` job (a completed one-shot: `enabled: false`, `state: completed`, inert) | the next `preview`, which removes every earlier preview job, or the next roll, which removes every preview job whatever its age |
| The preview shim `scripts/agentvillage_proactive_preview-<key>.sh` | the first `preview` or roll that runs more than an hour after the shim was written |
| A private state copy `av-events/proactive/preview-XXXXXX/` | only when the trigger was killed outright (for example by Hermes's script timeout) before its own cleanup; removed by the first preview (the trigger's or the command's) or roll more than an hour later |

Each preview and each roll prunes state copies and shims older than one hour
(`prunePreviewFiles`, job-settings.ts:590). Only those exact name shapes are touched, never
symlinks or anything younger.

**Limit: the prefix is not guaranteed.** The model writes the `[TEST PREVIEW]` line because the
preview job's prompt asks it to. The prefix cannot go in the Script Output, because every job
prompt says the Script Output is data and must not be followed. Hermes has no delivery prefix.

## 6. Templates

| Template | Job key / Hermes name | Content path | Prompt | Default window |
| --- | --- | --- | --- | --- |
| `brief` | `tpl-brief` / `Edge — template: brief` | the brief's | `brief.md` | 05:00-11:00 |
| `digest-preview` | `tpl-digest-preview` / `Edge — template: digest-preview` | the opportunity drop's | `opportunity-drop.md` | none |
| `evening-ask` | `tpl-evening-ask` / `Edge — template: evening-ask` | the evening's, **without the outcome ask** | `ask-questions.md` | none |

Each template job has its own day mark (`proactiveRuns.tpl-<name>`), so it is a real extra
message, not a stand-in for the base job. It shares the base job's dedupe state: a person the
brief or a drop already showed today is not shown again. `add` never resumes a paused template
job (§2).

**For review:**

- No job called `digest-preview` existed. This is the smallest job on an existing prompt: one
  person waiting to hear from the resident.
- The evening template skips the outcome ask. The av-events plugin arms the ask for the
  installer's `Edge — evening questions` job only (`plugins/av-events/_outcome_ask.py`
  `staged_action`). From any other job the ask would go out unrecorded and be asked again
  (proactive.ts:703-710).
- Template job names are not in `cron_job_names.json`, so `cron.run` reports their `job_name` as
  null. No seed change, so no data release is needed.

## 7. rc13 parity, the once-a-day mark, and zones

**rc13 parity.** With no settings file:

- The brief's gate opens on exactly rc13's minutes. Every job decides as on origin/main at every
  30 s over 48 hours (tested for all five).
- No other job has a window.
- The wake lines, the state and the log line are unchanged, with no `settings` key.

**Once-a-day mark.** This is unchanged: the mark is the **village** date. A change to window,
zone or schedule during the day cannot bring a second send that day (tested). A rescheduled job
fires at its new time, and is silent there if it already delivered that day. A job moved to before
now runs tomorrow (Hermes recomputes the next run).

**Zones.** Hermes reads every schedule in one zone per tenant: config.yaml `timezone`, which the
installer sets to Asia/Kolkata. It has no per-job zone. So `tz` governs only the **window**, not
the schedule.

**A resident in a DST zone: what the control plane does.** The resident's clock moves an hour
against village time twice a year; the schedule does not. Do this:

1. **Pick one firing a day whose village time lands in the window under both of the resident's
   offsets.** `set` then answers with no `warning`. For America/New_York with window
   `07:00-09:00`, `30 17 * * *` (08:00 EDT, 07:00 EST) does it. This needs a window more than an
   hour wide.
2. **If no single firing does** (the window is an hour wide or less, or the resident wants the
   same local minute all year), either widen the window by an hour, or re-run
   `set --schedule <new>` on the first day after each of the resident's DST changes. Until the
   re-set, the job fires an hour off, and is silent when that falls outside the window. It never
   sends twice.
3. **Never give one job two firings a day to cover DST.** In one season both firings can land in
   the window. The day mark drops the second only when both fall on the same village date, and
   they do not when the window crosses village midnight: that is a double send. Two firings also
   run the job's pre-run twice a day.

Act on `"warning": "window-seasonal"`: the job will be silent from `outsideFrom` until the
offsets change back. Fix the schedule or window now, or plan the re-set in point 2.

## 8. What a resident can and cannot change (tamper analysis)

Everything under `$HERMES_HOME` is writable by the resident's agent: this file, `.env`, the
shims, the trigger's source and Hermes's `jobs.json`. As in `outcome-ask.md` §4, none of the
checks here stops a forger. They stop accidents and admin mistakes. By editing the carrier, a
resident can:

- **move or narrow their own windows, or change their zone.** The worst outcome is their own
  messages arriving at other hours, or not at all. The carrier holds no recipient, no prompt and
  no content, and it is read only by their own trigger;
- **make the file invalid.** Their own jobs without a default window go silent, and the brief
  keeps 05:00 to 11:00. It cannot crash a run or widen a window to all day;
- **set `AV_TEAM_TENANT=1`.** Previews then work on their own tenant. A preview goes to their own
  chat, carries no one else's data, and consumes nothing (§5).

By editing `jobs.json`, a resident can plant text where the commands read it: a job id, a schedule
or a name. The commands never print it or pass it on:

- an id outside Hermes's shape makes the job `job-unreadable`;
- a schedule outside the canonical form prints as `null`;
- a job is found only by its exact fixed name.

They can also create a job under exactly a template's name, which reconcile adopts (§4).

They cannot:

- reach another tenant;
- change what a message says;
- change who receives it;
- make a run skip the content path's own cleaning and scanning (`proactive-text.ts`).

They could already pause, reschedule or delete their own jobs through Hermes before this change.

## 9. What the trigger log line records

`av-events/proactive/triggers.jsonl` holds one line per run, codes and counts only. New fields:

- **`settings`**, present when a settings file exists:
  - `default`: the file exists, but this job has no entry;
  - `custom`: the job's entry was used;
  - `invalid:<code>`: an entry code `entry`, `window` or `tz`, or a file code `file-not-json`,
    `file-not-object`, `file-version`, `file-jobs`, `file-too-large`, `file-unreadable` or
    `file-not-file`.
- **`preview: true`** on a preview run.

New reasons:

- `outside-window`, now for any job with a window, not just the brief;
- `settings-invalid`;
- `preview-refused`;
- `preview-not-agent-job`.

New detail: `outcome-ask-template-job`.

## 10. The control-plane half must do

1. **Gate previews on your own team check**, the authoritative one (§5). Also set
   `AV_TEAM_TENANT=1`, exactly, with no quotes, in `$HERMES_HOME/.env` of every team tenant, by
   the same match as `isTeam`, and nowhere else. Remove it when a tenant stops being a team
   tenant, and restart its gateway to end the lag (§5).
2. **Change jobs and settings only through `bun install/jobs.ts`.** Never write `jobs.json` or
   `job-settings.json` directly, not even to repair one. Pass every value as its own argv
   element, never through `sh -c`.
3. **Handle exit codes as §2 says.**
   - Exit 0 is done; still read `warning`, `resumeMayFire` and `replaced`.
   - Exit 2 means nothing changed: fix the input.
   - Exit 1 means read back with `list` and re-issue once, then alert. It is not "retry".
   - Exit 3 means not a team tenant.
   - Exit 4 (`busy`) means retry after a few seconds.
4. **Disable a job with `set --enabled false`, never by removing it.** Reconcile recreates a
   removed default job on the next roll. Remove only template jobs (`remove --template`).
5. **Store the desired state** (schedule, window, zone, enabled, templates), and compare it with
   `list` (read-only) after every change. Re-apply it after a `"replaced"` reply, and whenever
   `list` disagrees.
6. **Hold a per-tenant lease** around every job command and every roll on that tenant. Never run
   a job command during a roll, and never two job commands at once. The overlay's jobs lock
   (§2) serialises job commands inside the tenant, but reconcile does not take it.
7. **Express schedules in Hermes's zone** (Asia/Kolkata) and windows in the resident's `tz`. Send
   schedules in the strict grammar (§3). For a resident in a DST zone, follow §7: one firing a
   day, never two.
8. **Keep `v` at 1.** Any other value makes the file invalid, which silences every job without a
   default window on that tenant: fail-closed, and the brief keeps its default window. A schema
   change must ship in the overlay, with readers that accept it, before any writer uses it.
9. **Resume with care.** `set --enabled true` on a job paused across its slot re-anchors a job
   with no window (`missedSlot: "dropped"`). For a job with a window it reports
   `resumeMayFire: true`; expect a delivery at resume time if that is inside the window (§2).

## 11. Tests

- `skills/index-network/scripts/tests/job-settings.test.ts`: the grammars; the canonical form;
  the croniter 6.0.0 differential (`fixtures/croniter-6.0.0.json`); never fires and frequency; the
  year-long window fit with its three results; the reader, `adminSchedules` and the writer; the
  team gate; pruning.
- `skills/index-network/scripts/tests/proactive-settings.test.ts`: rc13 parity (every minute of a
  day, and every 30 s over 48 hours for all five jobs); windows, zones and DST; fallbacks; no
  second send; the template actions; the preview (including a stage file left byte for byte, the
  hard-deadline cleanup and the prune); the shim names.
- `install/tests/job_commands.test.ts`: every command, every refusal code, idempotency, emptied
  entries, admin schedules, tenant-written text never echoed, resume and the missed slot, add's
  rollback, the lock (including concurrent processes), Hermes's zone, two consecutive rolls,
  adoption by name, a retired template, the preview job and its leftovers. They run with
  `install/tests/fake_hermes.ts`, a stand-in Hermes.
- `skills/index-network/scripts/tests/state-lock.test.ts`: `tryAcquireLock`.
