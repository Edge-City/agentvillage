# Per-job delivery settings, add-from-template and the team-only preview (J2, overlay half)

Status: **as built**, 2026-10-05, for rc14, after review fix round 2. This is the contract the
control-plane half is built against: a control-plane lane should need nothing else. Hermes
references are to `~/.hermes/hermes-agent` at tag `v2026.9.24`; croniter references are to croniter
6.0.0, the version that Hermes tag pins. Overlay line numbers are at this PR's tip.

**DATA-376** (after rc19): a resident stops and restarts a scheduled message from chat, and the
pause script records a resident hold in the control plane's holds file (§4, "Resident holds").

**Fix round 2, in short** (each is in its section below):

- A schedule the tool sets always reads back: an input is at most 100 characters, a stored
  canonical form at most 346, the longest any accepted input produces (§3).
- The window check judges whole days, so its answer does not depend on the time of the call (§3).
- Hermes's zone: two names of one zone agree; only the tenant's files are read (§2, §3).
- `adminSchedules` is read entry by entry; a value that is not a list is reported
  (`adminSchedulesInvalid`); `list` and reconcile share one admin-managed rule; and
  `set --schedule default` clears an admin mark (§1, §2, §4).
- Each Hermes command is killed after 60 s (`hermes-timeout`); a holder checks the lock is still
  its own before each write (`lock-lost`) (§2).
- An unreadable `jobs.json` is never "no jobs": `list` says `store: "unreadable"`, and every
  mutating command refuses `jobs-store-unreadable` (§2).
- The rc13 parity test compares against rc13's decision frozen from origin/main (§7), and the
  trigger's hard-deadline path is tested in a child process (§5).

**Review residuals (M2b)**, each in its section below:

- A resume that loses the lock before its re-anchor says `resumeMayFire: true` on `lock-lost` (§2).
- A resume that Hermes saved and then failed or timed out says `resumeMayFire: true` too: every
  failure after a resume over a missed slot says it (§2, fix round 1).
- A write that repairs a non-list `adminSchedules` says `adminSchedulesRepaired: true` (§1, §2).
- `remove` reports `dropped` beside `adminSchedulesRepaired`, as `set` and `add` do (§2, fix
  round 1).
- `outsideFrom` can be today's or yesterday's date in the job's zone, meaning outside now (§2, §3).
- Zone links: only the listed names resolve, and any other pair of names for one zone is refused.
  A zone set only in the container environment can mistime one first run (§3).

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
| `adminSchedules` | a list of default job keys whose schedule an admin set with `set --schedule`; read entry by entry (below) | `[]` |

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

**Admin-managed.** Reconcile's legacy schedule migration (§4) never moves an admin-managed job. One
function decides it, `scheduleAdminManaged` (job-settings.ts:511), used by reconcile and reported
by `list` as `jobs[].adminSchedule`, so the two always agree:

| The settings file | Admin-managed |
| --- | --- |
| absent | no job |
| invalid (refused whole, §3) | every default job |
| `adminSchedules` present and not a list | every default job; `list` says `adminSchedulesInvalid: true`, and reconcile logs a warning |
| otherwise | a default job with an entry in `jobs` (its window or zone was checked against its schedule), or whose key is in `adminSchedules` |

Template jobs are never admin-managed: reconcile never migrates their schedule.

- **Read entry by entry** (`adminScheduleKeys`, :493). An entry that is not a default job key (a
  key a later release retired, a template key, a non-string) is ignored on its own, and never voids
  the other entries. The command that next writes the file drops it, and reports
  `"dropped": [..., "adminSchedules"]`.
- **A value that is not a list** counts every default job as admin-managed, so nothing an admin set
  is moved. The command that next writes the file (`set`, `add`, or a `remove` that rewrites it)
  writes all five default keys in its place (the same jobs reconcile was already treating as
  managed). It reports that as `"adminSchedulesRepaired": true`, so the caller knows every default
  job is now admin-managed on file. For compatibility, `set` and `add` still list
  `"adminSchedules"` in `dropped` as well. A command that writes no settings (a pause, say) leaves
  the value and reports nothing.
- `set --schedule <cron>` on a default job adds its key. The mark is kept when the job's window
  and zone are cleared, so a job whose only customisation is its schedule stays exempt.
- **`set --schedule default` clears it** (§2): it restores the job to the fleet's default schedule
  for this tenant and removes the key. A job that still has a window or zone entry stays
  admin-managed by that entry, which is harmless: its schedule is now the fleet default, which the
  migration never moves. The control plane never needs to delete the file to clear a mark.
- The mark matters only for a job whose schedule is the old synchronized default, the one schedule
  the migration moves. The trigger never reads `adminSchedules`.

**Not in the file.**

- **The schedule.** Hermes's job record holds it, and it is the only place Hermes reads one.
- **Enabled.** This is Hermes's pause state (`cron/jobs.py` `is_job_runnable`, line 521), which
  reconcile already keeps. There is one source of truth, and nothing was added for it.

**Written only by `install/jobs.ts`**, holding the jobs lock (§2). The write goes to a temp file
then a rename, mode 0600, in a 0700 directory (`replaceSettingsFile`, job-settings.ts:589). **The
control plane never writes this file directly**, not even to repair it. It changes it only through
the commands, which validate every value and keep the other jobs' entries.

## 2. Commands the control plane runs inside a tenant

Run each command from the overlay checkout, with the same `HERMES_HOME` and user as the installer.
Pass every value as its own argv element, never through `sh -c`.

**Environment.** `HERMES_HOME` must point at the tenant's home; it is the only environment the
tool reads about the tenant. Everything else about the tenant comes from files under it:
`cron/jobs.json`, `av-events/job-settings.json`, `.env` (`HERMES_TIMEZONE`, and `INDEX_API_KEY`,
the stagger seed) and `config.yaml` (`timezone`). The caller's own `HERMES_TIMEZONE` is never read,
and is removed from the environment the tool starts Hermes with, so Hermes's CLI reads the same two
files (`defaultContext`, jobs.ts). Two things outside the tenant still come from the environment:
the Hermes binary is found as the installer finds it (`HERMES_BIN`, then fixed paths, then `PATH`),
and the preview gate reads `AV_TEAM_TENANT` as §5 says (process environment first, then `.env`).

**Output.** Every command prints **exactly one line of JSON on stdout**:
`{"ok":true,...}` or `{"ok":false,"error":"<code>",...}`. Nothing in that line is free text from
the tenant: ids, schedules, zones and windows are printed only after they pass their grammar
(§3), and the settings file's problems appear only as codes. Hermes's own output goes to stderr.
Treat stderr as untrusted diagnostics from the tenant. Never parse it, and never hand it to a
model.

**Bounds.** Each flag may appear once, and only the command's own flags are accepted. Every value
is at most 200 characters (`MAX_ARG_CHARS`, jobs.ts:117); a longer one is refused as
`missing-value`. A schedule a caller passes is also at most 100 characters (the input bound, §3);
the canonical form the tool stores and reads back may be up to 346 (the canonical bound, §3).
`--allow-frequent` is a switch with no value, and is accepted only alongside `--schedule`.

**Hermes's job store.** Every command reads `$HERMES_HOME/cron/jobs.json` (`readJobsStore`,
jobs.ts:298). No file means no jobs, as Hermes reads it, and so does an object without `jobs`. A
file that is present but is not a regular file, is over 16 MiB (`MAX_JOBS_STORE_BYTES`), cannot be
read, is not JSON, or is not `{"jobs": [...]}` is **unreadable**, never "no jobs":

- `list` answers `{"ok":true,"store":"unreadable",...,"jobs":[],"missing":[],"unreadable":[]}`, so
  a caller never reads it as "every job missing, run a roll";
- `set`, `add`, `remove` and `preview` refuse `jobs-store-unreadable`, exit 1, `applied: []`,
  after the lock and before anything changes. Found part-way (the store became unreadable after a
  step), the same code comes with `applied` saying what was done.

Hermes repairs some shapes on its own next write (a bare list, an id-keyed map, control characters
in strings); this tool treats them as unreadable until then. Reconcile's own reader is unchanged.

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
- **Every Hermes command is killed (SIGKILL) after 60 s** (`HERMES_TIMEOUT_MS`, jobs.ts:124; also
  `hermes --version`, which then reads as `hermes-unavailable`). That step fails with
  `hermes-timeout`, exit 1; `applied` is read back from `jobs.json`, so it names the step if Hermes
  saved before it was killed.
- **A holder that runs past the stale time cannot write over the next one.** Before each write
  (each Hermes command, each settings or `installed_jobs.json` write, each shim copy) the holder
  checks that the lock file still holds its own token, and that the step can end before its lock
  goes stale (a Hermes command needs its full 60 s: none starts after 90 s of holding). If not, it
  stops with `lock-lost`, exit 1, writes nothing more (not even `add`'s rollback), and leaves the
  lock file to whoever holds it now. `applied` says what it did before. When `applied` holds
  `"enabled"` from a resume that found a missed run and the lock was lost before the re-anchor ran,
  the reply also says `resumeMayFire: true` (§2, "Pause, resume").
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
| `invalid-schedule` | 2 | | outside the schedule grammar (§3); or `--schedule default` on a template job, which has no fleet default | no |
| `invalid-window`, `invalid-tz`, `invalid-enabled` | 2 | | outside its grammar; `add` also refuses `default` | no |
| `schedule-never-fires` | 2 | | no run at all: croniter's impossible dates, or 29 February alone (§3) | no |
| `schedule-frequent` | 2 | | fires more than once in some hour, without `--allow-frequent` | only with `--allow-frequent`, if meant |
| `schedule-outside-window` | 2 | `schedule`, `window`, `tz` | no run lands in the window on any day of the coming year (§3) | no |
| `hermes-zone-unknown` | 2 | | a window check is needed, and Hermes's zone is unset in both `$HERMES_HOME/.env` and config.yaml, a set name is not one Hermes accepts, or the two name different zones (§3) | only after the zone is fixed. A roll fixes only the unset case: it writes config.yaml `timezone: Asia/Kolkata` when neither is set (`configureVillageTimezone`). It leaves a wrong or disagreeing value as it is (it only warns), so a person corrects `HERMES_TIMEZONE` in `.env` or `timezone` in config.yaml, then restarts the gateway |
| `job-not-installed` | 2 | `job` | no Hermes job by that name: a default job needs a roll; a template job needs `add` | no |
| `job-ambiguous` | 2 | `job`, `count` | two or more Hermes jobs carry the name | no; a person removes the extra one |
| `job-unreadable` | 2 | `job` | a job by that name has an id that is not Hermes's (`^[0-9a-f]{12}$`). Nothing is acted on, and the id is never passed to Hermes or printed. For `preview` the job is `"preview"`. | no; a person looks (a roll removes a retired or preview name) |
| `not-team-tenant` | 3 | | `preview` on a tenant without `AV_TEAM_TENANT=1` (§5) | no |
| `busy` | 4 | | the jobs lock is held | **yes** |
| `hermes-failed` | 1 | `step`, `applied`; `removed` (remove), `resumeMayFire` (reanchor, or `enabled` when Hermes saved a resume over a missed slot) | a Hermes command exited non-zero. `step` is one of `schedule`, `enabled`, `reanchor`, `create`, `edit`, `remove`, `remove-previous`. | read back, then once |
| `hermes-timeout` | 1 | as `hermes-failed` | a Hermes command ran past 60 s and was killed; `applied` is read back from `jobs.json` | read back, then once; again, alert (the CLI hangs) |
| `lock-lost` | 1 | `applied` | the jobs lock was taken over (this command ran past its stale time), or the next Hermes command could not end before it would be; nothing more was written | read back, then once |
| `jobs-store-unreadable` | 1 | `applied` (`[]` when refused at the start) | `cron/jobs.json` is present and unreadable (§2, "Hermes's job store"); `list` says `store: "unreadable"` | no; a person looks |
| `hermes-unavailable` | 1 | `applied: []` | the Hermes CLI does not run. Nothing changed. | yes, later (a restart may be in progress) |
| `settings-write-failed` | 1 | `applied` | the settings file could not be written | read back, then once |
| `prompt-missing`, `shim-missing` | 1 | `applied: []` | the overlay's prompt or shim is not installed. Nothing changed. | after a roll |
| `job-not-found-after-create` | 1 | `applied` | Hermes said it created the job, but no new job with a valid id is in `jobs.json` | no; alert |
| `schedule-readback-mismatch` | 1 | `applied` | after the edit or create, Hermes holds a schedule other than the canonical form sent | no; alert |
| `fault` | 1 | `applied` | an unexpected error (a bug) | no; alert |

`applied` is accurate on every failure, `fault` included. If Hermes exits non-zero (or is killed)
after it saved the change, the tool reads `jobs.json` back, and `applied` names that step too.

### `list`

`bun install/jobs.ts list` is read-only and takes no lock.

```json
{"ok":true,"store":"ok"|"unreadable","settings":"absent"|"ok"|"invalid:<code>","adminSchedulesInvalid":true?,"jobs":[{...}],"missing":["<default key>"],"unreadable":["<key>"]}
```

| Field | Meaning |
| --- | --- |
| `store` | `ok`, or `unreadable`: `cron/jobs.json` is present and cannot be read (§2). Then `jobs`, `missing` and `unreadable` are empty; it never means "run a roll". |
| `settings` | the file's state: absent, valid, or refused whole with a file code (§3) |
| `adminSchedulesInvalid` | `true` when the file's `adminSchedules` is present and not a list (every default job is then admin-managed, §1); absent otherwise |
| `jobs[].key` | the job key |
| `jobs[].id` | the Hermes id (always 12 hex characters) |
| `jobs[].name` | the job's fixed Hermes name, from the overlay |
| `jobs[].schedule` | the stored schedule in canonical form (up to 346 characters), or `null` when it is not canonical (set by hand, or not a cron expression). Every schedule these commands set reads back here. |
| `jobs[].scheduleUnreadable` | `true` when `schedule` is `null` (absent otherwise) |
| `jobs[].enabled` | Hermes's pause state: `false` when paused |
| `jobs[].window` | the effective window `HH:MM-HH:MM`, or `null` for none |
| `jobs[].tz` | the effective window zone |
| `jobs[].settings` | `absent` (no file), `default` (no entry), `custom` (the entry is used) or `invalid:<code>` (`entry`, `window` or `tz`, or a file code) |
| `jobs[].adminSchedule` | `true` when the job is admin-managed, by the same rule reconcile uses (§1): its key is in `adminSchedules`, it has an entry, or the file (or its `adminSchedules`) is unreadable. Always `false` for a template job. |
| `missing` | default jobs with no Hermes job (a roll recreates them); only with `store: "ok"` |
| `unreadable` | keys whose Hermes job has an id outside Hermes's shape. These jobs are left out of `jobs`. |

Template jobs appear only when added. A key whose name has two jobs appears twice.

### `set`

```
bun install/jobs.ts set --job <key> [--schedule "<cron>"|default [--allow-frequent]] [--window HH:MM-HH:MM|default] [--tz <zone>|default] [--enabled true|false]
```

It refuses in this order: grammar, lock, the job store, job lookup, Hermes availability, the window
check. Then it runs three steps in order and stops at the first failure (`setCommand`,
jobs.ts:748):

1. **The schedule**, if given and different from the stored one. It runs
   `hermes cron edit <id> --schedule <canonical>`, then reads the schedule back and compares it
   with the canonical form. The edit keeps the job's id and its pause state (`cron/jobs.py`
   `_apply_schedule_update`, line 1994). Hermes does not recompute the next run of a paused job
   (line 2002), so the next run stays stale until resume (below).
2. **The settings**, whenever `--schedule`, `--window` or `--tz` is given. The entry is merged:
   named fields are set or removed, other valid fields are kept, and invalid ones are dropped. An
   empty entry is deleted. `--schedule <cron>` on a default job adds its key to `adminSchedules`;
   `--schedule default` removes it. Written only if the bytes change.
3. **Enabled**: `hermes cron pause|resume <id>`, only when the job's state differs. A pause or
   resume alone is never refused and needs no window check.

**`--schedule default`** (default jobs only; a template job is refused `invalid-schedule`) gives the
job back to the fleet. The schedule becomes the fleet's default for this tenant as reconcile
computes it (`defaultScheduleFor`, install_index.ts:529; `fleetDefaultCron`, jobs.ts:742): the
job's staggered minute for the tenant's seed, `INDEX_API_KEY` as the installer persisted it in
`$HERMES_HOME/.env`, or the spec's own schedule when there is none. It is checked against the
window like any schedule, and the job's admin mark is cleared, so the next roll owns the schedule
again (tested over two consecutive rolls, and a later legacy schedule is migrated again). An
install-time override (`--digest-send-cron`, `DIGEST_SEND_CRON` and the like) lives only in a
roll's own arguments and environment and is not seen here. Run again, it changes nothing.

Success line:

```json
{"ok":true,"job","id","changed":[...],"schedule","enabled","window","tz", ...optional}
```

| Field | Meaning |
| --- | --- |
| `changed` | the steps that changed something, in order: `"schedule"`, `"settings"` (whenever the settings file's bytes changed: written, replaced or removed), `"enabled"` |
| `schedule` | the canonical schedule now in force, or `null` with `scheduleUnreadable: true` |
| `adminSchedule` | present when `--schedule` was given: whether the job is admin-managed now (§1). `false` after `--schedule default`, unless a window or zone entry keeps it managed. |
| `enabled`, `window`, `tz` | the state after the command |
| `check: "skipped"` | the job has a window, but its stored schedule is not canonical, so it could not be checked |
| `warning: "window-seasonal"`, `outsideFrom` | the schedule lands in the window on only some days of the year (§3). `outsideFrom` is `YYYY-MM-DD` in the job's zone. It is the job-zone date of the first firing on the first whole day, in Hermes's zone, on which no firing lands in the window. That day starts at the Hermes-zone midnight of the call, so `outsideFrom` may be the current or the previous calendar day in the job's zone. Either one means the job is outside its window now. |
| `frequent: true` | the schedule fires more than once in some hour (`--allow-frequent` was given) |
| `missedSlot: "dropped"` | a resume found a missed run, and re-anchored the next run so it does not fire (below) |
| `resumeMayFire: true` | a resume left a missed run due: the next Hermes tick may fire it (below) |
| `dropped` | names removed because they were invalid: `"window"`, `"tz"`, `"entry"` (the old entry was not an object) or `"adminSchedules"`. Present only when the file was written. |
| `adminSchedulesRepaired: true` | `adminSchedules` was not a list, and this write replaced it with all five default keys: every default job is now admin-managed on file (§1). Clear the ones that should not be with `--schedule default`. Present only when the file was written. |
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
  - **Residual race:** the two Hermes commands are separate processes. The gap between them is
    one Hermes CLI start, which can be several seconds on a loaded container (and at most the
    60 s timeout). A tick that falls in it can still fire the catch-up. Hermes v2026.9.24 has no
    atomic "resume without catch-up".
- If the job **has a window**, the catch-up is left alone, and the window gates it: it delivers
  at resume time only if that time is inside the window and the job has not delivered that
  village day. The reply says `resumeMayFire: true`.
- If the stored schedule is not canonical, the tool does not guess, and the reply says
  `resumeMayFire: true`.
- If the re-apply fails: exit 1, `step: "reanchor"`, `applied: ["enabled"]`,
  `resumeMayFire: true`. The catch-up will fire within a minute; there is nothing useful to retry.
- If the lock is lost after the resume and before the re-apply starts: exit 1, `lock-lost`,
  `applied: ["enabled"]`, `resumeMayFire: true`, for the same reason. A lock lost before the
  resume ran says nothing about a catch-up: the job is still paused.
- If the resume itself fails or is killed after Hermes saved it (`hermes-failed` or
  `hermes-timeout`, `step: "enabled"`, and the read-back shows the job enabled, so
  `applied: ["enabled"]`): the re-apply never ran, and the reply says `resumeMayFire: true`.
- The rule behind all of these: whenever a missed slot existed and the read-back shows the resume
  applied, every failure reply carries `resumeMayFire: true`. A resume that failed before Hermes
  saved it (`applied` without `enabled`) and a failed pause say nothing about a catch-up.
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
(`addCommand`, jobs.ts:874). It never creates two jobs. It refuses `default` for the window and
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
  `dropped`, `adminSchedulesRepaired` and `replaced` (the last three only when the file was
  written).

### `remove`

```
bun install/jobs.ts remove --template <name>
```

`removeCommand`, jobs.ts:998, removes every job of that name, its ids in `installed_jobs.json`,
and its settings entry. An emptied file is removed. If the file is unreadable it is left alone.

```json
{"ok":true,"job":"tpl-<name>","result":"removed"|"absent","removed":<n>,"changed":["job"?,"settings"?],"dropped":["adminSchedules"]?,"adminSchedulesRepaired":true?}
```

`dropped` and `adminSchedulesRepaired` mean what they mean for `set` and `add`, and appear only
when the settings file was rewritten. `remove` merges no entry, so the only name it can drop is
`"adminSchedules"`.

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

`parseStrictCron`, job-settings.ts:231; `parseStoredCron`, :242:

- Exactly five fields: minute, hour, day of month, month, day of week.
- Only `0-9 * , - /`, with **one space between fields** and none before or after. At most 100
  characters (the input bound, `MAX_SCHEDULE_INPUT_CHARS`).
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

**Two bounds.** What a caller may pass and what the tool may store are separate:

- **The input bound: 100 characters** (`MAX_SCHEDULE_INPUT_CHARS`, job-settings.ts:184), for what
  `--schedule` accepts.
- **The canonical bound: 346 characters** (`MAX_CANONICAL_SCHEDULE_CHARS`, :194), for what the tool
  stores and reads back (`parseStoredCron`: canonical exactly, up to 346). It is the longest
  canonical form any accepted input produces, computed from the field ranges: a field's longest
  canonical form lists every value but one shortest one (all of them is `*`), which is 167, 59,
  81, 24 and 11 characters for the five fields, plus four spaces. A 23-character input reaches it
  (`1-59 1-23 2-31 2-12 1-6`), and a 15-character one already passes 100
  (`0 6-20 1-28 * *`, 121). So every schedule the tool sets reads back: `list` shows it, a later
  `--window` checks it, and a resume can re-anchor it. A stored schedule that is not canonical is
  still not guessed at (`null`, `check: "skipped"`), whatever its length.

Both are tested: the figure by brute force over every subset size of every field, and as a
property over 6,000 generated expressions (every accepted one reads back), and end to end
(`set` then `list` round-trips to the same canonical string, the 346-character form included).

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

**Never fires** (`cronNeverFires`, job-settings.ts:274; `cronLeapDayOnly`, :286). These are
refused as `schedule-never-fires`:

- A restricted day of month that none of the listed months has: `0 8 31 2 *`, `0 8 30 2 *`,
  `0 8 31 4,6,9,11 *`. This is refused whatever the day of week says, because croniter searches
  the day of month alone first and raises `CroniterBadDateError` (croniter.py:717). Hermes then
  refuses the schedule on create and edit (`compute_next_run`, `cron/jobs.py:1204`, surfaced by
  `tools/cronjob_tools.py:945`).
- 29 February alone (`0 8 29 2 *`). croniter accepts it, but it runs once in four years; the tool
  refuses it so that every accepted schedule fires within any year.

**Frequency floor** (`cronFrequent`, :295). A schedule with two or more minute values fires more
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

`hermesZone`, jobs.ts:593. Hermes reads every schedule in one zone per tenant, and it reads that
zone in two places.

- **Hermes's CLI** computes the next run on `cron create`, `edit` and `resume`
  (`hermes_time.py` `_resolve_timezone_name`, lines 83-106). It reads `HERMES_TIMEZONE` first,
  then `timezone` in config.yaml, else the host's local time. A `$HERMES_HOME/.env` value
  overrides the process environment (`hermes_cli/env_loader.py:434`).
- **The gateway**, whose ticker fires the jobs, copies config.yaml's `timezone` over
  `HERMES_TIMEZONE` at startup (`gateway/run.py:2087-2089`). So there config.yaml wins.

The tool therefore reads both, **from the tenant's files only**: `HERMES_TIMEZONE` in
`$HERMES_HOME/.env` (as python-dotenv reads it) and `timezone` in `$HERMES_HOME/config.yaml`. The
caller's process environment is never read for the zone, and the caller's `HERMES_TIMEZONE` is not
passed on to Hermes, so the CLI the tool starts reads the same two (§2, "Environment").

**Two names of one zone agree only for the listed names.** Each set name is resolved first
(`canonicalZone` in jobs.ts): the runtime's own resolution, then a small table (`ZONE_LINKS`):

- `Asia/Calcutta` to `Asia/Kolkata`, the installer's two names for the village zone
  (`install/config.ts` `VILLAGE_ZONE_NAMES`);
- `UTC`, `UCT`, `Universal`, `Zulu`, `Etc/UCT`, `Etc/Universal` and `Etc/Zulu` to `Etc/UTC`.

So `.env` `Asia/Calcutta` with config.yaml `Asia/Kolkata` is one zone.

The runtime's resolution does no work on the bun CI pins, 1.4.2: `Intl.DateTimeFormat(...)
.resolvedOptions().timeZone` returns every link as written (`US/Eastern`, `Europe/Kiev`,
`Asia/Saigon`, `Asia/Calcutta`, `UTC` all stay as they are; checked, and pinned by a test in
`install/tests/job_commands.test.ts`). A runtime on ICU may resolve some links, perhaps the other
way (`Asia/Kolkata` to `Asia/Calcutta`). The table applies after either, so its names meet.

**Only the listed names resolve.** Any other pair of names for one zone counts as two zones and is
refused as `hermes-zone-unknown`: `US/Eastern` with `America/New_York`, or `Europe/Kiev` with
`Europe/Kyiv`. That is the conservative direction: the tool never accepts a pair that might be two
zones, at the cost of refusing some that are one. The fix is to set the same name in both places.

If they are set to different zones, the CLI and the ticker would disagree, and the zone is
unknown. Because a disagreement is refused, the order between the two cannot change a result. The
zone is also unknown when neither is set (Hermes would use the host's local time), or when either
set name is not one Hermes accepts (it would log a warning and fall back to local time).

An unknown zone is refused as `hermes-zone-unknown`, and only when a window check needs it. It is
never assumed to be Asia/Kolkata. A roll fixes only an unset zone (it writes config.yaml
`timezone: Asia/Kolkata` when neither source is set); a wrong or disagreeing value it leaves, with
a warning, for a person to correct (§2, the code's retry note).

**A zone set only in the container's environment.** The tool starts Hermes's CLI without the
caller's `HERMES_TIMEZONE` (`defaultContext`), so the CLI reads only the tenant's `.env` and
config.yaml. The installer leaves config.yaml's `timezone` unset only when `HERMES_TIMEZONE` names
a non-village zone, and it warns when it does (`configureVillageTimezone`). On such a tenant, if
`HERMES_TIMEZONE` is set only in the container's environment, the CLI the tool starts computes the
next run it stores in the host's local time, while the gateway's ticker reads the container's
zone. A window check would refuse first (`hermes-zone-unknown`, since neither file names a zone).
A job with no window has no check, so a `set --schedule`, or a resume (whose re-anchor re-applies
the schedule), can give that job one mistimed first run before the gateway re-anchors it. The fix is the same as for any wrong zone: set
`timezone` in config.yaml (or `HERMES_TIMEZONE` in `$HERMES_HOME/.env`).

Accepted names are those Hermes's zoneinfo takes: `Asia/Kolkata`, `Asia/Calcutta`, `Etc/UTC`,
`Etc/GMT+5`, `US/Eastern`, `UTC`, `EST5EDT`. The name must use IANA capitalisation and be known to
this runtime's zone database (`isHermesZoneName`, jobs.ts:510). The installer sets config.yaml's
`timezone` to Asia/Kolkata (`install/config.ts` `configureVillageTimezone`).

### Schedule against window

`scheduleWindowFit`, job-settings.ts:409; `windowCheck`, jobs.ts:613. Whenever `set` or `add`
changes a job's schedule, window or zone and the job has a window, the schedule is checked
against the window. It is read in Hermes's zone, firing by firing, for **a full year of whole
days** starting with today in Hermes's zone (`WINDOW_CHECK_DAYS = 366`), so both DST changes of any
zone fall inside the check. Only days on which the schedule runs count (month, day of month, day of
week). A day lands when at least one of its firings is in the window, read in the job's zone.

**Whole days only.** Today counts all its firings, those already past included, so the answer
does not depend on the time of the call: `0 6,12 * * *` with window `05:00-11:00` is accepted
with no warning whether it is checked at 00:00, 07:00 or 13:00 (before fix round 2, a call at
07:00 dropped the 06:00 firing and called the day a miss). Tested from all 24 hours of a day, with
a real DST case still warning with the same `outsideFrom`.

| Result | The command |
| --- | --- |
| every day it runs lands | accepts |
| no firing ever lands | refuses `schedule-outside-window` |
| some days land and some do not (a DST change in either zone) | accepts with `"warning": "window-seasonal"` and `"outsideFrom": "YYYY-MM-DD"`, never silent. `outsideFrom` is the job-zone date of the first firing on the first whole Hermes-zone day on which nothing lands. |

For example, `0 18 * * *` village time with window `08:00-09:00` America/New_York lands until
1 November (08:30 EDT), then not until March (07:30 EST): the reply is `window-seasonal`,
`outsideFrom: "2026-11-01"`.

**`outsideFrom` can be today or yesterday.** The days are whole days in Hermes's zone, starting
with the day of the call. A firing just after Hermes's midnight falls on the previous calendar day
in a zone behind it. Take `30 0 * * *` village time with window `11:00-12:00` America/Los_Angeles,
checked at 05:00 PDT on 12 October. The first whole day is 12 October IST, and its 00:30 firing was
12:00 PDT on 11 October, outside the window (the end is exclusive). From November, 11:00 PST is
inside. The reply is `window-seasonal` with `outsideFrom: "2026-10-11"`, yesterday in the job's
zone. An `outsideFrom` on or before the job's current date means the job is outside its window
now. `job-settings.test.ts` pins this case from both sides of the Los Angeles midnight.

A stored schedule that is not canonical cannot be checked; the reply then says
`"check":"skipped"`. Every schedule the tool itself set is canonical and within the canonical
bound, so it is always checked.

### Reading at run time

`readJobSettings` / `deliveryFor`, job-settings.ts:451 and :547. The read never throws, and it
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
**shape** in place: prompt, script, agent mode and failure target (`staleShapeFields`, :496;
`cronEditArgs`, :480). Hermes keeps the id, the schedule, the pause state and the next run on an
edit (header, :28-34). Reconcile never writes `job-settings.json`. It reads it only to see which
jobs are admin-managed, by the rule `list` reports (`scheduleAdminManaged`, §1).

| What | Survives a roll? | Where |
| --- | --- | --- |
| A default job's custom schedule | yes, never compared | `scheduleStale`, install_index.ts:774 |
| A default job's schedule set by an admin to the old synchronized default (`0 8 * * *`) | yes: the job is admin-managed (an entry, or its key in `adminSchedules`, which `set --schedule` always writes) and skipped by the legacy migration | `adminManaged`, :699; used at :774 |
| The legacy migration for a job that is not admin-managed | unchanged from rc13 | :774 |
| An entry of `adminSchedules` that is not a default job key | ignored on its own; the other entries still count | `adminScheduleKeys`, job-settings.ts:493 |
| An unreadable settings file, or an `adminSchedules` that is not a list | every default job counts as admin-managed, and reconcile logs a warning saying so | :699-707 |
| A job given back with `set --schedule default` | its schedule is the fleet default, which the migration never moves; with no mark, the roll owns it again (a later legacy schedule is migrated as on rc13) | §2 |
| Pause state (enabled) | yes, `cron edit` keeps it | header :28-34; Hermes `cron/jobs.py:1994` |
| Window, zone and `adminSchedules` | yes, reconcile never writes the file | (no reference: reconcile has no write) |
| A template job (`Edge — template: <name>`, template still in `TEMPLATE_NAMES`) | kept, with its id, schedule and pause state; its shape is edited like a default job's; it is listed in `installed_jobs.json`; it is never created by reconcile | retire filter :717; template loop :738 |
| A job a resident created under exactly a template's name | **adopted**: reconcile treats it as the template job and rewrites its prompt and script | template loop :738 |
| A near-name of a template (`Edge — template: Brief`) or a retired template's job | removed, like any `Edge —` name that is not current, which is the existing prefix rule | :717 |
| A leftover `Edge — preview` job | removed, whatever its age; a roll in the minute before a preview fires cancels that preview | :717 |
| Preview state copies and preview shims older than an hour | removed | `prunePreviewFiles`, :710 |
| A fleet change to a prompt, a script or agent mode | still applied to every job, including admin-managed and template jobs | template loop and spec loop |
| A fleet change to a default window or zone | reaches every job without an override (defaults live in code, not the file) | `DEFAULT_WINDOWS`, job-settings.ts:65 |

Tests cover two consecutive rolls for all of these. They run end to end against a stand-in Hermes
that keeps `jobs.json`: `install/tests/job_commands.test.ts`, "what a roll keeps".

### Resident holds (DATA-376)

A resident can stop and restart a scheduled message from chat. The agent runs
`bun skills/index-network/scripts/pause-job.ts pause|resume --label "<Label>"`
(`skills/index-network/tools.md`, "Cron schedule"); `status` reads the same state and changes nothing. The
script records a hold in the control plane's holds file, `$HERMES_HOME/av-events/job-holds.json`,
then pauses or resumes the label's installed jobs through the Hermes CLI. The control plane reads
that file before its contact-style apply and its job-settings apply, and leaves a held job as it
is.

The file now has two writers: the control plane (`printf` to a temp file, then `mv`;
`job-control.js` `writeHoldsCmd`) and this script (a temp file, then a rename). Each reads the
whole file, changes its own entries and replaces the file whole. The format is the control
plane's, one line:

```json
{"version":1,"holds":{"<id>":"paused"},"at":{"<id>":"<ISO time>"},"by":{"<id>":"resident"}}
```

- `holds` is `paused` or `active`. `by` is `admin`, `desired` or, new here, `resident`: the
  resident's own agent placed the hold. A hold without `by` is an admin's, as before. The
  control-plane half of DATA-376 adds `resident` to its readers; until it is deployed, a
  resident hold reads as an admin's.
- The script reads the file as the control plane does (`head -c 65536`, then `parseHolds`): its
  first 65536 bytes, decoded as UTF-8 with replacement characters, then parsed. A longer file is
  not unreadable by itself: its first 64 KiB are what is parsed. Unreadable means a prefix that is
  not JSON or not a JSON object, a path that is not a regular file, or a failed read. So a hold the
  control plane sees, the script sees too, whatever padding or stray bytes the file carries.
- On an unreadable file a **resume is refused** (`holds-unreadable`, exit 2, before any Hermes
  call), as every control-plane resume path fails closed on it (the job-settings apply sends no
  resume, the contact style only pauses, the run triggers skip). A **pause still runs** (fewer
  messages is the safe direction) and the file is never written; the reply says
  `"hold": null, "holds": "unreadable"`.
- An entry is kept only when its id has Hermes's shape (`^[0-9a-f]{12}$`) and its state is one of
  the two. Its `at` is kept only when it is an ISO time, its `by` only when it is one of the three
  words. Everything else is dropped on the next write, as the control plane's writer drops it.
  The control plane's id grammar is wider, but no Hermes job has an id of another shape, so
  nothing it acts on is lost. Nothing read from the file is ever printed.

What a run does to a job's hold:

| Run | Hold before | Hold after |
| --- | --- | --- |
| pause | none, `active`, or `paused` by `desired` | `paused`, `by: resident`, `at` now |
| pause | `paused` by an admin (or no `by`) | kept as it is |
| pause | `paused` by `resident` | kept if the job was already paused; else a new `at` |
| resume | `paused` by an admin (or no `by`) | refused, `held-by-admin`, exit 2, before any Hermes call |
| resume | `paused` by `desired` | refused, `held-by-settings`, exit 2 |
| resume | the file is unreadable | refused, `holds-unreadable`, exit 2 |
| resume, contact-style job | none, `active`, or `paused` by `resident` | `active`, `by: resident`, `at` now; an admin's `active` is kept |
| resume, any other job | none, `active`, or `paused` by `resident` | removed |

This follows the control plane's own pause and resume routes (cp#87): a pause holds `paused` for
any job; a resume holds `active` for a contact-style job (otherwise the contact-style apply would
set it to the style) and removes the hold of any other job.

**Resume.** After the resume the script reads the job again. If its next run is already due, it
re-applies the schedule, as `set --enabled true` does (§2, "Pause, resume and Hermes's
catch-up"). Unlike `set`, it does so for a job with a delivery window too: a message restarted
from chat comes back at its usual time, never at once. A job that is already running but whose
next run is due gets the same re-anchor, so a retry after a run cut off between its resume and
its re-anchor (`reanchor` or `lock-lost`) finishes the job. The cost: a running job asked to
resume in the very minute of its own slot loses that slot. A stored schedule that is not canonical
is not guessed at; the reply says `resumeMayFire: true`, on the job and at the top. The race
between the two CLI processes stays.

**The lock.** Pause and resume take the tenant's jobs lock (`av-events/jobs.lock`, §2), so the
script never runs beside a `jobs.ts` command; a held lock is `busy`, exit 4. The control plane's
own holds writes do not take this lock (they run under its rewire lease). The script reads the
file again just before it writes, so a control-plane write can be lost only if it lands between
that read and the rename. The control plane's compare-and-swap (a digest check, then `mv -f`) has
the same kind of gap: the script's rename landing between that check and the `mv` is lost, and
the resident hold with it. Both windows are milliseconds wide.

**Order and retries.** The hold is written first, for every job of the label, then Hermes runs.
So the control plane never finds a job paused by the resident and not yet held: a contact-style
apply or a job-settings resume landing while the script runs sees the hold and leaves the job
(cp `docs/JOBS.md`, "Two writers", asked for this). If a job's Hermes step then fails, is cut off
by a lost lock, or reads back wrong, the script puts that job's entry back as it read it, but only
while the entry still reads as the script wrote it (anything written since is someone else's and
stays). A failed put-back is reported as `holdError: "hold-restore-failed"` beside the Hermes
error. The reply's `hold` is the asked hold when the file holds it for every job of the label at
the end, else `null`. Every step is idempotent: a second pause changes nothing and calls Hermes
zero times, and a retry after any failure converges.

The control-plane side (the third `by` word, what undoes a resident hold, the settings GET's
`hold`) is `docs/JOBS.md` in the control-plane repo. Tests: `install/tests/pause_job.test.ts`.

## 5. The preview, and how the team gate works

**The signal.** On rc13 the overlay cannot tell a team tenant from a resident. Team status
(`isTeam`, `AV_EMIT_IS_TEAM`) lives only in the control plane, derived from
`CONTROL_PLANE_TEAM_EMAILS`. This PR adds one variable that the tenant reads: `AV_TEAM_TENANT`
(`isTeamTenant`, job-settings.ts:623).

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
- Its prompt is `PREVIEW_PREAMBLE` (jobs.ts:101) followed by the job's own prompt. The preamble
  tells the model to start the reply with the line `[TEST PREVIEW]`.
- Every earlier `Edge — preview` job is removed first, so there is one at a time.

**What a preview does not touch.** In the trigger, a preview:

- ignores the window and the day mark;
- **never takes the state lock**, so a real run is never delayed or silenced by it;
- reads the state file once, without the lock (every write of it is a rename), into a private
  copy under `av-events/proactive/preview-*/`;
- runs the content path against that copy. The copy is deleted afterwards, on the normal path and
  on the 100 s hard-deadline exit (`hardStopCleanup`, proactive.ts:817, called by `main`'s
  deadline timer; tested end to end in a child process that runs the real `main` with a 300 ms
  deadline and a content path that never returns, `fixtures/proactive-deadline-child.ts`);
- applies no record, writes no day mark, stages no outcome ask, and clears no real stage
  (proactive.ts:707; tested: a seeded stage file is left byte for byte).

A preview before the real run, or after it, changes nothing the real run reads. The Script Output
is the real run's, and no message wording changed.

**What a preview can leave behind, and for how long.**

| Leftover | Present until |
| --- | --- |
| The last `Edge — preview` job (a completed one-shot: `enabled: false`, `state: completed`, inert) | the next `preview`, which removes every earlier preview job, or the next roll, which removes every preview job whatever its age |
| The preview shim `scripts/agentvillage_proactive_preview-<key>.sh` | the first `preview` or roll that runs more than an hour after the shim was written |
| A private state copy `av-events/proactive/preview-XXXXXX/` | only when the trigger was killed outright (for example by Hermes's script timeout) before its own cleanup; removed by the first preview (the trigger's or the command's) or roll more than an hour later |

Each preview and each roll prunes state copies and shims older than one hour
(`prunePreviewFiles`, job-settings.ts:654). Only those exact name shapes are touched, never
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
  (proactive.ts:707-714).
- Template job names are not in `cron_job_names.json`, so `cron.run` reports their `job_name` as
  null. No seed change, so no data release is needed.

## 7. rc13 parity, the once-a-day mark, and zones

**rc13 parity.** With no settings file:

- The brief's gate opens on exactly rc13's minutes. Every job decides as on origin/main at every
  30 s over 48 hours (tested for all five). The test compares the trigger's live decision path
  (`windowDecision`, proactive.ts:765, which `runAgentAction` calls) against rc13's decision
  frozen as a fixture, copied verbatim from origin/main at `9ff10b9`
  (`skills/index-network/scripts/tests/fixtures/rc13-decision.ts`, never edited), so it cannot
  drift with the source. The trigger no longer carries rc13's `inBriefWindow`.
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
   element, never through `sh -c`. Run it with `HERMES_HOME` set to the tenant's home (§2,
   "Environment"); the caller's own `HERMES_TIMEZONE` makes no difference.
3. **Handle exit codes as §2 says.**
   - Exit 0 is done; still read `warning`, `resumeMayFire` and `replaced`.
   - Exit 2 means nothing changed: fix the input.
   - Exit 1 means read back with `list` and re-issue once, then alert. It is not "retry".
     `jobs-store-unreadable` is the exception: alert at once, and do not run a roll for it.
   - `list` with `store: "unreadable"` is not "jobs missing": alert, never roll.
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
10. **Give a default job's schedule back with `set --job <key> --schedule default`**, never by
    deleting the settings file. It restores the fleet's default for that tenant and clears the
    admin mark (§1, §2). When `list` says `adminSchedulesInvalid: true`, the next write repairs it
    (all five marked); clear the ones that should not be marked with `--schedule default`.
11. **Keep your own command timeout above 150 s**, the jobs lock's stale time. A command never
    waits on Hermes for more than 60 s per step, and stops with `lock-lost` rather than write past
    its lock (§2), but a command you kill leaves the lock for up to 150 s (`busy`).

## 11. Tests

- `skills/index-network/scripts/tests/job-settings.test.ts`: the grammars; the canonical form and
  its two bounds (the 346 figure by brute force, and a 6,000-expression property that every
  accepted input reads back); the croniter 6.0.0 differential (`fixtures/croniter-6.0.0.json`);
  never fires and frequency; the year-long window fit with its three results, from all 24 hours of
  a day; the reader, `adminSchedules` entry by entry, `scheduleAdminManaged` and the writer; the
  team gate; pruning.
- `skills/index-network/scripts/tests/proactive-settings.test.ts`: rc13 parity (every minute of a
  day, and every 30 s over 48 hours for all five jobs, against `fixtures/rc13-decision.ts`);
  windows, zones and DST; fallbacks; no second send; the template actions; the preview (including
  a stage file left byte for byte, the hard-deadline cleanup, in process and through `main` in a
  child process, and the prune); the shim names.
- `install/tests/job_commands.test.ts`: every command, every refusal code, idempotency, emptied
  entries, admin schedules, tenant-written text never echoed, resume and the missed slot, add's
  rollback, the lock (including concurrent processes), Hermes's zone, two consecutive rolls,
  adoption by name, a retired template, the preview job and its leftovers; and, from fix round 2,
  long canonical schedules read back, whole-day window checks, zone links and the caller's
  environment, `adminSchedules` entry by entry with `list` and reconcile agreeing for every file
  shape, `--schedule default` over two rolls, Hermes timeouts, a lost lock, and an unreadable
  store. They run with `install/tests/fake_hermes.ts`, a stand-in Hermes (it can also hang, as a
  hung CLI would).
- `skills/index-network/scripts/tests/state-lock.test.ts`: `tryAcquireLock` and `holdsLock`.

## 12. The review's open questions, answered

- **How does a caller recognise an unreadable store?** `list` says `store: "unreadable"` with
  empty `jobs`, `missing` and `unreadable`; every mutating command refuses `jobs-store-unreadable`,
  exit 1 (§2). It never reads as "every job missing".
- **How does a caller see a malformed `adminSchedules`, and clear an admin mark?** `list` says
  `adminSchedulesInvalid: true` (and every default job `adminSchedule: true`); reconcile logs a
  warning. An entry that is not a default job key is simply ignored. A mark is cleared with
  `set --job <key> --schedule default` (§1, §2).
- **What happens when a holder runs past the stale time?** No Hermes command runs longer than 60 s
  (`hermes-timeout`), none starts unless it can end before the lock goes stale, and before every
  write the holder checks the lock is still its own; otherwise it stops with `lock-lost` and writes
  nothing more (§2).
- **Which environment must `jobs.ts` run in?** `HERMES_HOME` pointing at the tenant's home; every
  tenant fact comes from files under it, never from the caller's environment (§2, "Environment").
