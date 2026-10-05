# Per-job delivery settings, add-from-template and the team-only preview (J2, overlay half)

Status: **as built**, 2026-10-05, for rc14. This is the contract the control-plane half is built
against. Hermes references are to `~/.hermes/hermes-agent` at tag `v2026.9.24`. Line numbers are
at this PR's tip.

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
(`install/jobs.ts set`), with no roll. And reconcile never reads or writes it, so a roll cannot
undo it (§4).

**Schema** (`skills/index-network/scripts/job-settings.ts`):

```json
{"v": 1, "jobs": {"brief": {"window": "06:30-09:00", "tz": "Asia/Kolkata"}, "tpl-digest-preview": {"window": "16:00-18:30"}}}
```

| Field | Rule | Default when absent |
| --- | --- | --- |
| `v` | exactly the number `1` | (required) |
| `jobs` | an object keyed by job key | `{}` |
| `jobs.<key>.window` | `HH:MM-HH:MM`, 24-hour, two digits each; start inclusive, end exclusive; start after end runs across midnight; start equal to end is invalid | the job's default window |
| `jobs.<key>.tz` | an IANA zone (rules in §3) | `Asia/Kolkata` |

**Job keys.** The five default agent jobs are `brief`, `drop-midday`, `drop-evening`,
`negotiation` and `evening`. The three template jobs are `tpl-brief`, `tpl-digest-preview` and
`tpl-evening-ask`. The prefetch has no settings, because it delivers nothing.

**Defaults** (`DEFAULT_WINDOWS`, job-settings.ts:64):

- `brief` and `tpl-brief`: 05:00 to 11:00, which is rc13's brief window.
- Every other job: no window. It delivers whenever its schedule runs it, as on rc13.

The file holds overrides only. `set --window default` deletes the key; it never writes the
default's value. So a fleet change to a default reaches every job without an override (§4,
"the reverse").

**Not in the file.**

- **The schedule.** Hermes's job record holds it, and it is the only place Hermes reads one.
- **Enabled.** This is Hermes's pause state (`cron/jobs.py` `is_job_runnable`, line 522), which
  reconcile already keeps. There is one source of truth, and nothing was added for it.

**Written** by `install/jobs.ts` only: a temp file then a rename, mode 0600, in a 0700 directory
(`writeJobSettings`). The control plane may write the file itself, but the commands validate
first and keep the other jobs' entries. Use them.

## 2. Commands the control plane may run inside a tenant

Run each command from the overlay checkout, with the same `HERMES_HOME` and user as the
installer. Every command prints **exactly one line of JSON on stdout**; Hermes's own output and
logs go to stderr. Exit codes:

- **0**: done.
- **2**: refused before anything changed (a value outside its grammar, an unknown or ambiguous
  job, a schedule that never lands in its window, a missing flag).
- **3**: a preview refused because the tenant is not a team tenant.
- **1**: a step failed part-way. `applied` lists what had already changed, so retry the same
  command.

Errors look like `{"ok":false,"error":"<code>", ...}`.

| Command | Success line (exit 0) |
| --- | --- |
| `bun install/jobs.ts list` | `{"ok":true,"settings":"absent"\|"ok"\|"invalid:<code>","jobs":[{"key","id","name","schedule","enabled","window":"HH:MM-HH:MM"\|null,"tz","settings":"absent"\|"default"\|"custom"\|"invalid:<code>"}],"missing":["<default key>"...]}` |
| `bun install/jobs.ts set --job <key> [--schedule "<cron>"] [--window HH:MM-HH:MM\|default] [--tz <zone>\|default] [--enabled true\|false]` | `{"ok":true,"job","id","changed":["schedule"?,"settings"?,"enabled"?],"schedule","enabled","window","tz"}`, plus `"check":"skipped"` (stored schedule not in the strict grammar), `"dropped":["tz"...]` (an invalid old field removed) or `"replaced":"invalid:<code>"` (an unreadable file replaced) when they apply |
| `bun install/jobs.ts add --template <brief\|digest-preview\|evening-ask> --schedule "<cron>" [--window HH:MM-HH:MM] [--tz <zone>]` | `{"ok":true,"job":"tpl-<name>","id","result":"created"\|"updated"\|"unchanged","schedule","window","tz"}` |
| `bun install/jobs.ts remove --template <name>` | `{"ok":true,"job":"tpl-<name>","result":"removed"\|"absent","removed":<n>}` |
| `bun install/jobs.ts preview --job <key>` | `{"ok":true,"job","id","fires":"in 1m"}`; refused: exit 3, `{"ok":false,"error":"not-team-tenant"}` |

**Refusal codes (exit 2):**

- Command line: `unknown-command`, `unknown-flag`, `duplicate-flag`, `missing-flag`,
  `missing-value`, `nothing-to-set`.
- Values: `invalid-job`, `invalid-template`, `invalid-schedule`, `invalid-window`, `invalid-tz`,
  `invalid-enabled`.
- Jobs: `job-not-installed`, and `job-ambiguous` (two Hermes jobs carry the name).
- `schedule-outside-window`, which echoes `schedule`, `window` and `tz`.

**Failure codes (exit 1):** `hermes-failed` (with `step`), `hermes-unavailable`,
`settings-write-failed`, `prompt-missing`, `shim-missing`, `job-not-found-after-create`, `fault`.

**set** (`setCommand`, jobs.ts:291). It runs three steps in order and stops at the first failure:

1. The schedule, as `hermes cron edit <id> --schedule <expr>`. The edit keeps the job's id and
   its pause state (`cron/jobs.py` `_apply_schedule_update`, line 1994).
2. The settings entry. It is written whenever a schedule, window or zone is set, so the job then
   counts as admin-managed (§4).
3. `hermes cron pause|resume <id>`, only when the job's state differs.

A pause or resume alone is never refused.

**add** (`addCommand`, jobs.ts:365). It writes the settings entry first, so the job never runs,
not even once, without its window. Then it copies the shim and creates the job. It is
idempotent: if a job of that template exists, its schedule and shape are edited in place, and two
adds never make two jobs. The new id is added to `av-events/installed_jobs.json`.

**remove** (`removeCommand`, jobs.ts:439). It removes every job of that name, its settings entry
and its ids in `installed_jobs.json`.

**preview** (`previewCommand`, jobs.ts:468). See §5.

**Nothing reaches a shell.** Every value is matched against its grammar (§3) before use. Hermes
is started with `execFileSync(bin, argv)`. A template name selects one of three fixed specs; it is
never interpolated into a path or a name.

## 3. Validation rules

**Schedule** (`parseStrictCron`, job-settings.ts:175):

- Exactly five fields: minute, hour, day of month, month, day of week.
- Only `0-9 * , - /` and single spaces; at most 100 characters.
- Every number inside its field's range. Day of week is 0 to 6.
- A range's end must be above its start. `a-a` is refused, because croniter reads it as the whole
  field.
- A step from 1 to the field's width.
- No names, `?`, `L`, `W`, `#`, `@daily`, intervals or Hermes phrases.

The expression is passed on with its fields joined by single spaces.

**Window** (`parseWindow`, job-settings.ts:82): `^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$`,
with start and end different. `24:00`, `5:00`, en dashes, spaces and a missing end are all refused.

**Zone** (`isValidTimeZone`, job-settings.ts:118). Accepted: `UTC`, or `Area/Location` (or
`Area/Region/Location`) where:

- the area is one of Africa, America, Antarctica, Arctic, Asia, Atlantic, Australia, Europe,
  Indian or Pacific;
- the runtime's time zone database resolves the name to exactly the same spelling.

Refused: offsets, POSIX names (`EST5EDT`), `Etc/` and `US/` links, and case variants.

Bun's `Intl.supportedValuesOf("timeZone")` is the older CLDR list. It holds `Asia/Calcutta` but
not `Asia/Kolkata`. So a name in that list passes, and so does a name the database resolves to
itself.

**Schedule against window** (`scheduleMeetsWindow`, job-settings.ts:228). `set` and `add` refuse a
schedule that would never deliver. The test is whether any of its times of day, read in Hermes's
zone (`hermesZone`: `timezone` in config.yaml, else `HERMES_TIMEZONE`, else Asia/Kolkata), lands
in the window, read in the job's zone, on any of the next 14 days. Only the minute and hour fields
are read. A stored schedule outside the strict grammar (set by hand, or a Hermes phrase) cannot be
checked; the reply then says `"check":"skipped"`.

**Reading at run time** (`readJobSettings` / `deliveryFor`, job-settings.ts:253 and :306). The
read never throws, and it never widens a window.

- **The file is refused whole** when it is not a regular file, is over 64 KiB, cannot be read, is
  not JSON, is not an object, has `v` other than `1`, or has `jobs` that is not an object.
- **One entry is refused** when it is not an object, or when its `window` or `tz` fails its rule.

Either way, the job falls back to its **default window** if it has one: the brief keeps 05:00 to
11:00 Asia/Kolkata. A job with **no default window is held silent** (`settings-invalid`), because
falling back to "no window" would mean all day. A bad zone never falls back silently to another
zone.

Unknown top-level keys, unknown job keys and unknown entry fields are ignored.

## 4. What survives a roll

A roll runs `reconcileDigestCronJobs` (`install/install_index.ts`). It edits an existing job's
**shape** in place: prompt, script, agent mode and failure target (`staleShapeFields`, :483;
`cronEditArgs`, :467). Hermes keeps the id, the schedule, the pause state and the next run on an
edit (header, :28-34). Reconcile never reads or writes `job-settings.json`, except to see whether
a job has an entry.

| What | Survives a roll? | Where |
| --- | --- | --- |
| A default job's custom schedule | yes, never compared | `scheduleStale`, install_index.ts:739 |
| A default job's schedule set by an admin to the old synchronized default (`0 8 * * *`) | yes: a job with a settings entry is admin-managed and skipped by the legacy migration (`set --schedule` always writes the entry) | `adminManaged`, :672; used at :739 |
| The legacy migration for a job with no entry | unchanged from rc13 | :739 |
| Pause state (enabled) | yes, `cron edit` keeps it | header :28-34; Hermes `cron/jobs.py:1994` |
| Window and zone | yes, reconcile never writes the file | (no reference: reconcile has no write) |
| A template job (`Edge — template: <name>`, template still in `TEMPLATE_NAMES`) | kept, with its id, schedule and pause state; its shape is edited like a default job's; it is listed in `installed_jobs.json`; it is never created by reconcile | retire filter :682; template loop :700-722; :789 |
| A template job whose template was retired from `TEMPLATE_NAMES` | removed, like any retired `Edge —` name | :682 |
| A leftover `Edge — preview` job | removed | :682 |
| A fleet change to a prompt, a script or agent mode | still applied to every job, including admin-managed and template jobs | :708, :740 |
| A fleet change to a default window or zone | reaches every job without an override (defaults live in code, not the file) | `DEFAULT_WINDOWS`, job-settings.ts:64 |

Tests cover two consecutive rolls for all of these. They run end to end against a stand-in Hermes
that keeps `jobs.json`: `install/tests/job_commands.test.ts`, "what a roll keeps".

## 5. The preview, and how the team gate works

**The signal.** On rc13 the overlay cannot tell a team tenant from a resident. Team status
(`isTeam`, `AV_EMIT_IS_TEAM`) lives only in the control plane, derived from
`CONTROL_PLANE_TEAM_EMAILS`. This PR adds one variable that the tenant reads: `AV_TEAM_TENANT`.

- The tenant is a team tenant only when the value is exactly `1`, read from the process
  environment, else `$HERMES_HOME/.env` (`isTeamTenant`, job-settings.ts:344).
- Nothing in the overlay sets it. Until the control plane sets it, every preview is refused
  everywhere.

**Two gates.**

1. `jobs.ts preview` refuses (exit 3) before creating anything.
2. The trigger refuses too (`runPreview`, proactive.ts:817, check at :820). A preview job that
   reaches a non-team tenant by any route stays silent (`preview-refused`): the model is never
   woken, so nothing is delivered.

**How a preview runs.** Hermes cannot pass a flag to a pre-run script (§1), and it cannot run a
paused job by hand (`tools/cronjob_tools.py` `_claim_for_manual_run`, line 184). It also forwards
a manual run to the gateway when delivery is relay-fronted (`_forward_relay_fronted_run`, line
124). So the preview is its own job:

- `preview` creates one Hermes **one-shot** job, `Edge — preview`, on schedule `in 1m` (Hermes
  `parse_schedule`, the `in <duration>` form). Hermes retires it after its single run
  (`cron/jobs.py` `_complete_job_record`, line 1561).
- The job delivers to telegram with failure target `local`.
- Its script is the shim under the name `agentvillage_proactive_preview-<key>.sh`, which runs
  `proactive.ts <key> --preview`.
- Its prompt is `PREVIEW_PREAMBLE` (jobs.ts:73) followed by the job's own prompt. The preamble
  tells the model to start the reply with the line `[TEST PREVIEW]`.
- An earlier preview job is removed first, so there is one at a time. A roll removes a leftover.

**What a preview does not touch.** In the trigger, a preview:

- ignores the window and the day mark;
- **never takes the state lock**, so a real run is never delayed or silenced by it;
- reads the state file once, without the lock (every write of it is a rename), into a private
  copy under `av-events/proactive/preview-*/`;
- runs the content path against that copy, and deletes the copy afterwards;
- applies no record, writes no day mark, stages no outcome ask, and clears no real stage.

A preview before the real run, or after it, changes nothing the real run reads. The Script Output
is the real run's, and no message wording changed.

**Limit: the prefix is not guaranteed.** The model writes the `[TEST PREVIEW]` line because the
preview job's prompt asks it to. The prefix cannot go in the Script Output, because every job
prompt says the Script Output is data and must not be followed. Hermes has no delivery prefix.
The gate, not the prefix, is what keeps a preview from a resident.

## 6. Templates

| Template | Job key / Hermes name | Content path | Prompt | Default window |
| --- | --- | --- | --- | --- |
| `brief` | `tpl-brief` / `Edge — template: brief` | the brief's | `brief.md` | 05:00-11:00 |
| `digest-preview` | `tpl-digest-preview` / `Edge — template: digest-preview` | the opportunity drop's | `opportunity-drop.md` | none |
| `evening-ask` | `tpl-evening-ask` / `Edge — template: evening-ask` | the evening's, **without the outcome ask** | `ask-questions.md` | none |

Each template job has its own day mark (`proactiveRuns.tpl-<name>`), so it is a real extra
message, not a stand-in for the base job. It shares the base job's dedupe state: a person the
brief or a drop already showed today is not shown again.

**For review:**

- No job called `digest-preview` existed. This is the smallest job on an existing prompt: one
  person waiting to hear from the resident.
- The evening template skips the outcome ask. The av-events plugin arms the ask for the
  installer's `Edge — evening questions` job only (`plugins/av-events/_outcome_ask.py`
  `staged_action`). From any other job the ask would go out unrecorded and be asked again
  (proactive.ts:703-707).
- Template job names are not in `cron_job_names.json`, so `cron.run` reports their `job_name` as
  null. No seed change, so no data release is needed.

## 7. rc13 parity, the once-a-day mark, and zones

**rc13 parity.** With no settings file:

- The brief's gate opens on exactly rc13's minutes; the tests check every minute of a day.
- No other job has a window.
- The wake lines, the state and the log line are unchanged, with no `settings` key.

**Once-a-day mark.** This is unchanged: the mark is the **village** date. A change to window,
zone or schedule during the day cannot bring a second send that day (tested). A rescheduled job
fires at its new time and is silent there if it already delivered that day. A job moved to before
now runs tomorrow (Hermes recomputes the next run).

**Zones.** Hermes reads every schedule in one zone per tenant (config.yaml `timezone`, which the
installer sets to Asia/Kolkata). It has no per-job zone. So `tz` governs only the **window**, not
the schedule.

For a resident whose zone has DST, put two firings in the schedule, one for each side of the
change. For example, `30 16,17 * * *` IST with window `07:00-09:00` America/New_York. The window
keeps the one that lands, and the day mark drops the second.

Caveat: a schedule that fires twice inside one window that crosses **village** midnight can
deliver twice in that window, because the two firings fall on two village dates. Give one firing
per window.

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
  chat, carries no one else's data, and consumes nothing.

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

1. **Set `AV_TEAM_TENANT=1` in `$HERMES_HOME/.env` of every team tenant**, by the same match as
   `isTeam`, and nowhere else. Remove it when a tenant stops being a team tenant. Until it is set,
   preview is refused everywhere.
2. **Change jobs only through `bun install/jobs.ts`.** Do not edit `jobs.json` or
   `job-settings.json` directly. Pass every value as its own argv element, never through
   `sh -c`. Treat exit 2 as "nothing changed, fix the input", exit 1 as "retry", and exit 3 as
   "not a team tenant".
3. **Disable a job with `set --enabled false`, never by removing it.** Reconcile recreates a
   removed default job on the next roll. Remove only template jobs (`remove --template`).
4. **Express schedules in Hermes's zone** (Asia/Kolkata), and windows in the resident's `tz`. Use
   two firings for a DST zone (§7).
5. **Store the desired state** (schedule, window, zone, enabled, templates) and re-apply it after a
   `"replaced"` reply. **Read it back** with `list`, which is read-only.
6. **Do not run job commands during a roll** on the same tenant. They are not locked against
   reconcile.
7. **Run `preview` only for team tenants.** The overlay refuses the rest, but the caller should
   not ask.

## 11. Tests

- `skills/index-network/scripts/tests/job-settings.test.ts`: the grammars, the reader, the gate.
- `skills/index-network/scripts/tests/proactive-settings.test.ts`: rc13 parity, windows, zones and
  DST, fallbacks, no second send, the template actions, the preview, the shim names.
- `install/tests/job_commands.test.ts`: every command, argument refusal, idempotency, two
  consecutive rolls, a retired template, the preview job (with `install/tests/fake_hermes.ts`, a
  stand-in Hermes).
