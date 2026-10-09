# Releases: Deploy and Roll

**This is the front door for how anything in the Agent Village reaches production.**
Status: rewritten 2026-10-02 from the live workflows and run history. The other
release documents are listed at the end; each covers one component's detail and
points back here.

## The rule

Merging to `main` in any repo means integrated and reviewed. It does not mean
live. Three different things ship, each by its own path, and each leaves a record.

| What ships | Repo | How it goes live | Record |
|---|---|---|---|
| Service code: the control plane and the landing page | `Edge-City/agentvillage-controlplane`, `Edge-City/agentvillage-landing` | The **Deploy** workflow moves that repo's `release` branch, which Railway builds | Annotated tag `release-YYYY-MM-DD[.N]` naming who ran it and the commits that went live |
| Agent content: skills, prompts, installer, the `av-events` plugin | this repo, `Edge-City/agentvillage` | An annotated tag on `main` (the **Tag release** workflow here creates it), then the **Roll** workflow updates every resident's VM to it | The tag; a GitHub Deployment per roll (environment `residents`); a `tenant.updated` event per resident carrying the tag |
| The data pipeline: ingest and dbt | `Edge-City/agentvillage-data` | The **Deploy** workflow in that repo moves its `release` branch and checks or applies migrations; a hand fast-forward push is the fallback | The `release` branch tip; `releases/manifest.yaml`, written by PR after the fact |

No shared version number, no release calendar. During the event (Oct 11 to
Nov 1) fixes ship one component at a time, each reversible by moving its
pointer back.

## Deploy: service code

**Where.** Actions tab, workflow "Deploy", "Run workflow", branch `main`:
https://github.com/Edge-City/agentvillage-controlplane/actions/workflows/deploy.yml
and https://github.com/Edge-City/agentvillage-landing/actions/workflows/deploy.yml.

**Inputs.** `ref` (default `main`; a commit, branch or tag that is on `main`)
and `rollback` (default off). There is no dry run: a run is a release.

**What a run does.**
1. Plan: refuses unless dispatched from `main`; resolves `ref`; a normal deploy
   must be a fast-forward of `release` and on `main`; a rollback must be an
   earlier state of `release` or carry a `release-*` tag; a ref already live is
   a no-op.
2. Test at the target commit. Control plane: the root `npm ci` exactly as Railway
   installs it, a load check, lockfile parity, `bun test`, the roll script tests.
   Landing: frozen `bun install`, `bun run test`, `tsc --noEmit`.
3. Release: one atomic push with a lease on the `release` head read at plan
   time. It moves `release` and creates the dated tag. A run that loses a race
   fails and moves nothing. Only this job is serialised.
4. Wait up to 20 minutes for Railway to build that commit. Without a Railway
   token it prints that the check was skipped and that `release` has moved.

**Roll back.** Same button, `rollback` ticked, `ref` set to an earlier
`release-YYYY-MM-DD` tag. Tests still run at that commit.

**What Deploy does not do.** Control-plane database migrations apply at boot and
have no down path, so a rollback never reverses schema. Railway variables and
settings are untouched; a change that needs a new variable gets it set by a
Railway admin first. The landing button has not yet had its first run; the live
landing commit was a hand push.

## Roll: agent content from this repo

Every resident's agent runs in its own VM and clones this repo at the ref the
control plane's `EDGE_HERMES_REF` names. A roll sets that variable to a new tag
and then updates one resident at a time: sync the checkout, rerun the installer,
restart the gateway. It verifies each VM is on the tag's commit and its gateway
is running and not crash-looping, skips residents already proven healthy on the
tag, and stops at the first failure. Everything after the stop is untouched.

**Where.** Actions tab, workflow "Roll agents to residents", "Run workflow",
branch `main`:
https://github.com/Edge-City/agentvillage-controlplane/actions/workflows/roll.yml.
Records: https://github.com/Edge-City/agentvillage-controlplane/deployments
(environment `residents`). Its own manual is `docs/ROLL.md` in that repo and wins
where this page is briefer.

**Inputs.**

| Input | Meaning |
|---|---|
| `tag` | An annotated tag on this repo's `main`, e.g. `v2.0.0-rc8`. Never a branch. |
| `dry_run` | Default on: prints the plan and changes nothing. |
| `scope` | `test-tenants` (default: the canaries, i.e. every live tenant owned by a team member, plus any extra ids in the `ROLL_TEST_TENANTS` repository variable) or `all`. |
| `pause_seconds` | Wait after each resident before checking it. Default 60, minimum 10. |
| `allow_seed_change` | Default off. The data owner's confirmation that ingest already carries changed plugin seed files. |

**Before a roll.**
1. Tag the merged commit with the **Tag release** button. Actions tab, workflow
   "Tag release", "Run workflow", branch `main`:
   https://github.com/Edge-City/agentvillage/actions/workflows/tag-release.yml.
   Inputs: `ref` (default `main`; a commit, branch or tag that `main`
   contains), `dry_run` (default on: plans and runs the suites, creates
   nothing), `version` (leave empty for the highest `vX.Y.Z-rcN` plus one;
   give one only to start a new line or after a final version) and `note`
   (optional, one line of at most 200 characters, e.g. what the tag
   deliberately leaves out; it goes on its own `Note:` line in the tag
   message). Run a dry run
   first and read its summary: the version, the commit, the commits since the
   previous release tag and the seed check. Then run again with `dry_run`
   unticked and `ref` set to the commit the dry run showed (`main` gets bot
   commits several times a day). The real run tags only after this repo's
   suites pass at that commit, pushes only the annotated tag (its message
   names who ran it, the run, the commits and the seed check), and its summary
   gives the Roll inputs. It refuses, creating nothing, when the ref is not on
   `main`, the commit already carries a release tag (roll that one), the commit
   does not contain the latest release tag, a branch has the new tag's name, the
   `version` given exists or is not higher than every release tag, a tag that
   looks like a release has a number longer than 6 digits, a directory that
   `test.yml` runs `bun test` on does not exist at the commit
   (`suite_dir_missing`: the suites would otherwise pass without running it),
   or the tags or the seed check changed while it ran. Text from the
   repository (commit subjects, seed `version` strings, tag names) is cleaned
   of control characters and shown as code in the summary; a seed `version`
   that is not one plain string is shown as `(unreadable version)` and counts
   as changed. Anyone with write access to this repo can run it
   (`scripts/tag-release.ts` holds the logic). Its actions are pinned by
   commit SHA, unlike this repo's other workflows, because its tag job holds a
   token that can write; the suites it calls run in their own read-only jobs.
   Fallback, by hand: `git tag -a v2.0.0-rcN <commit> -m "..."` and
   `git push origin v2.0.0-rcN`.

   | Tag release problem | What to do |
   |---|---|
   | The suites fail at the commit | Nothing was created. Fix on `main` and tag the new commit, or give an earlier `ref` whose suites pass. |
   | "The tags changed since this run planned" or the push was rejected | Someone tagged meanwhile; nothing of this run was pushed. Run again (a dry run first). |
   | `suite_dir_missing` | The commit predates a suite directory that `test.yml` on `main` runs. Release a newer commit, or tag by hand after running the suites that exist at that commit. |
   | GitHub refuses the tag push from the workflow's token (a permission or rule error in the tag job) | Tag by hand with the fallback above. If it keeps happening, a repository admin can add a write deploy key as a secret and the workflow can push with it, as the control plane's and data repo's Deploy buttons do; not set up today. |
2. If the tag changes `plugins/av-events/tool_categories.json`,
   `edgeos_tool_allowlist.json` or `cron_job_names.json`, release the data
   pipeline with those seeds first, or the new events are quarantined. The
   button refuses such a tag until `allow_seed_change` is ticked. The Tag
   release summary names the changed files and their `version` strings
   against the previous release tag and says whether to tick
   `allow_seed_change`; it cannot see the data pipeline's release, so check
   that with the data owner (see "The data pipeline" below). Roll compares
   with what the residents run now (`EDGE_HERMES_REF`, a tag or a branch tip),
   so if they are behind the previous tag it can name more files, and it
   refuses with `seed_uncomparable` when it cannot read that ref.
3. Make sure your own agent is a canary. Each agent answers only its owner's
   Telegram, so the human check in the procedure below only works on a tenant
   you own. The control plane marks every tenant whose sign-up email is in its
   `CONTROL_PLANE_TEAM_EMAILS` variable as a team tenant, and every live team
   tenant is a canary automatically, including one you recreate. If your email
   is not in that list, ask a Railway admin to add it. `ROLL_TEST_TENANTS` on
   the controlplane repo is optional, for extra canaries that are not
   team-owned. The dry-run summary lists the canaries with their source, so
   confirm yours is there.
4. Post one line in the group chat. Each resident's agent restarts once, and
   Telegram messages sent during that restart are dropped.

**The staged procedure.** Every roll is two runs with a human in between,
because the button can confirm a gateway is running but not that the agent
answers.
1. Dry run, `scope: test-tenants`. Read the plan: the tag's commit, the current
   `EDGE_HERMES_REF`, whether seeds changed, the residents in order.
2. Real run, same inputs. From this moment every new signup and every recreated
   VM gets the new tag, even if you stop here.
3. Message your own canary agent on Telegram and get a reply. Only the owner
   can do this, which is why every team member's tenant is a canary. Then confirm
   its events still arrive in the research database and nothing was
   quarantined (the button cannot see ingest). No reply after a second try:
   roll back.
4. Leave the test tenants on the tag for 48 hours of real use. The readiness
   gates in `agentvillage-data/docs/readiness-checklist.md` are measured over
   them during that time.
5. Dry run then real run with `scope: all`, at a quiet hour for Goa (IST).
   Residents already proven healthy on the tag are skipped.

**What a roll changes on an agent.** The installer rewrites the overlay's
files and the `config.yaml` keys it owns (README, "Install"), among them
the Telegram display keys: from the roll on, a resident sees no reasoning and
one tool-progress bubble per reply, deleted with the reply (RC28; DATA-409 had it
off), which they can switch with `/verbose`; its lines name the tool, never the
command, not even a `terminal` code block (the `av-display` plugin; web search
keeps its query); `AV_DISPLAY_DEFAULTS=0` opts a
tenant out of those display keys (not the `av-display` plugin entry or the
installer's other keys). Reasoning is still stored in the agent's `state.db`; it is
hidden, not deleted.

**When it refuses.** A refusal changes nothing. The common ones: the tag is
lightweight, missing or not on `main`; a branch has the tag's name; seed files
changed without `allow_seed_change`; the control plane is unhealthy or has not
restarted since the variable was set; no canary is live; another real roll
is running or a newer roll record exists. It also stops before the first update
if the canary source changed between the plan and the run. Fix the cause and
run again.

**When it stops.** The summary names each resident's result: rolled, rejected,
unreachable, busy, outcome unknown, or failed. Check every failed, unknown or
busy resident by hand. To resume, start a new run with the same tag: healthy
residents are skipped and the stopped one is updated again at its normal turn.

**Roll back.** Run the workflow with the previous tag, test tenants first. A
rollback is an ordinary roll and restarts every resident in scope again. Going
back to a release from before DATA-314 needs one more step per resident first;
see "The proactive jobs" below.

**What Roll does not guarantee.** That the agent answers. That Telegram
messages sent during a restart arrive (Hermes drops them on a cold start; the
installer's `drop_pending_on_cold_boot` fix needs a Hermes build from
2026-09-20 or later in the VM). That events arrive at ingest. A resident's agent
memory: no memory backups run in production yet, so a bad roll has no memory
undo.

**First use of the Tag release button.** Once, by the owner, before relying
on it:
1. The pull request that added it merged with its `test` checks green (that
   run also shows `test.yml` still checks out the pull request's own commit).
2. Settings > Actions > General lets a workflow ask for write access through
   its `permissions:` (the repository default is read; an organisation policy
   can cap it).
3. No ruleset or tag rule stops `github-actions[bot]` from creating `v*` tags.
4. A dry run with `ref` `main`. If `main` still sits on the latest release tag
   it refuses with "already tagged"; that is the expected first result.
5. Once `main` has moved past it, a dry run again: the version is the next
   rc, the previous tag is the latest one, the commit list and the seed check
   match what you expect.
6. In that run, the `test` jobs checked out the planned commit (their checkout
   step names it) and passed.
7. The plan step's log has no stray annotations and the summary renders as a
   table with code spans.
8. A real run with `dry_run` unticked, `ref` the full commit id from the dry
   run, the same `version` and `note` if you gave them.
9. `git fetch --tags` and `git cat-file -p <tag>`: annotated, tagger
   `github-actions[bot]`, a message naming you, the run, the commit, the seed
   check and the commits; `git ls-remote --heads origin` unchanged.
10. If the push was refused: tag by hand with the fallback and see the
    troubleshooting table above.
11. If the seed check named files, confirm with the data owner that the data
    pipeline's release carries those versions before ticking
    `allow_seed_change`.
12. Roll's dry run takes the tag (annotated, on `main`); then continue with
    the staged procedure.

## India reference content (skills/edge-india)

The village knowledge skill ships a snapshot of the public India wiki, Substack
and website in `skills/edge-india/references/`. The sync workflow
(`.github/workflows/sync-edge-india-references.yml`) keeps that snapshot on
`main` current with the upstream indexer (`p2p-lanes/edge-agent-skill`), every
15 minutes, refusing incomplete trees and any tree the agents' knowledge sync
would refuse. That directory on `main` is the mirror the `Edge — knowledge
sync` job pulls ("Edge India knowledge" below), so this is the one part of
agent content that does not wait for a roll: the job copies it into
`$HERMES_HOME/knowledge/edge-india/` every 30 minutes, verified against
`SNAPSHOT.json`. End to end, an edit Fran's publisher has committed reaches the
agents 30 to 65 minutes later (publisher 15 min, mirror 15 min, box job 30 min,
plus raw.githubusercontent's 5 min cache); a session already open reads the
guide at its next start (DATA-393; read back on 2026-10-07: upstream commit
14:58Z, on a1909a4b's box by 21:55Z after the rc24 roll). The skill's `refs.ts` reads the newer of that copy and the
snapshot installed at the roll (the offline fallback). **Its own live check,
`AV_INDIA_REFS_LIVE`, is off by default: the cron supplies freshness and a
resident's turn never fetches.** `AV_INDIA_REFS_LIVE=1` in one tenant's `.env`
opts that agent in (a diagnostic, not a rollout setting);
`skills/edge-india/README.md` has the full freshness path.
Rolling a tag that adds or changes this skill touches no seed files.

## The proactive jobs (DATA-314)

Six scheduled jobs reach a resident or prepare for one. Each is triggered by a
deterministic pre-run script: Hermes runs
`$HERMES_HOME/scripts/agentvillage_proactive_<action>.sh` (one shim,
`skills/index-network/scripts/shims/agentvillage_proactive.sh`, installed
under six names), which runs `skills/index-network/scripts/proactive.ts
<action>`. The script does every deterministic step and prints the facts as
JSON, then the wake line; the model only writes language from that Script
Output. No prompt of the six asks for a tool call, so a model that mangles tool
arguments cannot break a job.

The prompts the installer stores in these jobs live in
`skills/index-network/prompts/` (`brief.md`, `opportunity-drop.md`,
`negotiation-summary.md`, `ask-questions.md`), with the memory signal sync's
`memory-signals.md` and its gate `skills/index-network/scripts/memory_signal_gate.py`
(installed as `$HERMES_HOME/scripts/agentvillage_memory_signal_gate.py`). Until
DATA-361 they lived under `skills/edge-esmeralda/`; the move changed no job name,
id, schedule or prompt text, so an update finds every job up to date.

| Job | Time (Hermes's zone, which must be IST; staggered) | Action | What the model is given |
|---|---|---|---|
| Edge — digest prepare | 02:00 | `prefetch` | Nothing: the one `no_agent` job of the six (the knowledge sync, "Edge India knowledge" below, is the other `no_agent` job). It writes the brief's context to `av-events/proactive/brief-context.json` and is always silent. |
| Edge — daily digest | 08:00 | `brief` | Dates, weather, organiser announcements, today's schedule facts, the resident's interests and notes, the count of eligible new matches, up to three cleaned names, the Connections link, the count of things waiting in their approvals. |
| Edge — opportunity drop (midday), (evening) | 12:00, 17:00 | `drop-midday`, `drop-evening` | One person: cleaned name, profile and message links. |
| Edge — negotiation summary | 14:00 | `negotiation` | The resident's own signals; cleaned names with their links. |
| Edge — evening questions | 19:00 | `evening` | One person (cleaned name, links), or the last-day closeout question. |

The rules the trigger holds:
- **No third-party free text reaches the model.** Only dates, the resident's
  own data, sanitised schedule facts, organiser announcements, Index counts and
  cleaned names; no headline, summary or description written by or about
  another person. Every string is cleaned (`proactive-text.ts`: control,
  format and default-ignorable characters, markup, backticks and links
  removed, length capped) and scanned with a mirror of Hermes's cron prompt
  scanner, and withheld on a hit; the whole output is scanned once more before
  the model is woken. Cleaning repairs rather than refuses: a dot between
  letters gets a space after it (`R.Krishnan` is `R. Krishnan`, and no domain
  stays a link), and in names and titles the full stops that act as a domain
  dot (U+3002, U+FF0E, U+FF61) are read as dots first. Third-party text a
  non-organiser can write (event titles and venues) also loses `@`, a `$`
  before a letter (no cashtag; `$20` stays) and phone-shaped digit runs (10 to
  15 digits with spaces, dashes, dots or parentheses between, or `+` and 7 or
  more; `2026-2027` and `1000000` stay), and a `/` gets a space on both sides
  (`AI / ML`) unless it is between digits (`10/12`, `24/7`), one at the very
  start or end dropped, so no `/command` Telegram makes tappable reaches the
  message. The resident's notes (read from the agent's memory files) and
  signals (read back from Index) get the same strict cleaning, since either can
  hold text that did not come from the resident. Names lose phone runs too and are refused only
  when nothing is left, when command-shaped, or on a scanner hit. A pick (the
  drops, the evening note, the follow-up) skips a card whose name does not
  clean, so it never spends the day's slot.
- **The brief only between 05:00 and 11:00 IST.** Outside it the trigger is
  silent; the other jobs have no window.
- **Once per day per job.** The day is marked done in
  `memory/heartbeat-state.json` (`proactiveRuns.<action>`) at the moment the
  trigger wakes the model. A run that then fails loses that day; there is no
  delivery tracking. A mark counts as done only when it is a real calendar
  date equal to today's village date or the day after it, so a clock that
  moved back by a day cannot deliver twice; any other mark (further ahead, or
  malformed) is ignored and overwritten at the next wake.
- **The state file is locked** (`memory/heartbeat-state.json.lock`) while a
  trigger reads and writes it, and written by temp file and rename. A state
  file that was read but is not a JSON object (bad JSON, `[]`, `null`) or is
  over 5 MB is renamed aside under the lock as
  `heartbeat-state.json.corrupt-<UTC stamp>` (the three newest are kept), the
  run log line carries `note: state-renamed-aside`, and the run continues from
  an empty state. A state file that cannot be read at all (a permission or
  I/O error) is left alone and the run is silent with `state-unreadable`. A
  stale lock that cannot be removed ends the wait at once
  (`state-lock-stuck`).
- **Every delivered message is recorded.** No `no_agent` job delivers text (a
  `no_agent` job's stdout would reach the resident with no model turn, so no
  message event or archive entry), and every job that delivers sends a failure
  notice to `local`, never to the resident's chat.
- Agent-job triggers always exit 0 with the wake line last; a fault is a silent
  run with a code. Each run appends one line of codes and counts to
  `av-events/proactive/triggers.jsonl` (never a name, a URL or any text).
- **A failed pre-run script never reaches the resident.** When the script
  does not finish (Hermes's script timeout, a missing shim, a cancelled run)
  Hermes skips the wake gate, heads the block `Script Error` and asks the
  model to report it, and the reply would go to the resident's chat. Every
  resident-facing prompt says to reply exactly `[SILENT]` when the block above
  is headed Script Error or there is no Script Output.

**Village time.** Hermes reads every cron schedule in one zone:
`HERMES_TIMEZONE`, then `timezone:` in `config.yaml`, else the host's local
time (`hermes_time.py`); under the multiplexed gateway only `config.yaml`
counts, and the gateway copies a configured `timezone` over
`HERMES_TIMEZONE` when it starts. The six schedules are written in village
time and the brief delivers only between 05:00 and 11:00 IST, so on a host
whose Hermes zone is not IST every job fires at the wrong village hour and the
brief is silent every day. The installer therefore:
- writes `timezone: Asia/Kolkata` into `config.yaml` when no zone is
  configured (no `timezone` key or an empty one, and `HERMES_TIMEZONE` unset or
  already `Asia/Kolkata`), with one log line. It never overwrites a value set
  by hand;
- changes nothing when another zone is configured, in `config.yaml` or in
  `HERMES_TIMEZONE` (environment or `$HERMES_HOME/.env`), and prints one line
  starting `!! WARNING:` that names the zone and says the six jobs will run at
  the wrong village time and the brief will be silent. Fix it by hand.

Hermes reads the key when the gateway starts, so it takes effect at the
restart that ends the install. Each existing job's stored `next_run_at` is an
absolute time; Hermes fires it once more at that time (its
`timezone_migration` catch-up; on a host ahead of IST it moves it to the
village hour instead) and from then on at the village hour. On a
host that was not on IST that one run of the brief falls outside its window
and is silent, and the once-per-day mark stops any other job from delivering
twice on one village date. The same key also moves, on such a host, every
other Hermes clock to IST: the date line of the agent's system prompt,
message timestamps, the cron tool's times, and any job a resident created
(its hours are re-read in IST). Release note: on a host that was not on IST,
a resident's own pre-existing cron jobs have their hours read as IST after
the first roll.

**The script timeout.** A trigger waits up to 60 s for the state lock and
stops itself at 100 s, so Hermes's `cron.script_timeout_seconds` must be
about 110 s or more. The installer sets it to 120 when it is unset, holds
Hermes's own default of 3600, or is lower than 120; another value set by hand
is kept.

**Cron wrapper (DATA-373).** The installer sets `cron.wrap_response: false`
in `config.yaml` at install and at the standalone reconcile
(`configureCronWrapResponse`), so Hermes no longer wraps a cron delivery in
its "Cronjob Response: <job name>" header (with the job id) and its "To stop
or manage this job" footer. Instead each delivering prompt ends with its own
label line, `(<Label> message - you can ask me to stop or manage it)`, which
the model writes as the message's last line and leaves off a `[SILENT]`
reply. The labels and their jobs: Daily digest = `Edge — daily digest`;
Conversation update = `Edge — negotiation summary`; Evening questions =
`Edge — evening questions`; Introduction suggestion = both opportunity drops;
Usage report = `Edge — token usage audit` (opt-in). Template jobs added by an
operator carry their base prompt's line. The agent stops and restarts any of
the five on a resident's request (`skills/index-network/tools.md`, "Cron schedule") with
`skills/index-network/scripts/pause-job.ts` (DATA-376). Under the tenant's
jobs lock, the script first records a `by: resident` hold in
`av-events/job-holds.json`, the control plane's holds file, then pauses or
resumes the job through the Hermes CLI; a job whose Hermes step fails gets
its old entry back (docs/design/job-settings.md, "Resident holds"). Writing
the hold first closes the window the control plane's docs/JOBS.md ("Two
writers") asks the overlay to close. A resume is refused when the job is held
paused by an admin or the settings, or when the holds file cannot be read.
With the DATA-376 control-plane half deployed, an update or roll leaves a
resident-held job paused, and a newer switch in the app wins. A resume
re-applies the schedule, so no missed slot fires at once, and a retry
finishes a re-apply that was cut off; the race of two CLI processes stays, as
for `jobs.ts set --enabled true`. Until the control-plane half is deployed
the hold is written but not honoured, so this overlay ships in the tag after
that deploy. Times stay fixed.
av-events strips one trailing manage line (`normalise.manage_line` in
`plugins/av-events/outcome_question.json`) before matching the evening
outcome question, so a model that adds the line to the question still arms
the ask. The gap: the config step runs before `installIndex()`, so under
`--skip-index`, or for a job left in `cron_failed`, deliveries carry neither
Hermes's footer nor a manage line until the next roll that succeeds.

**The Connections link.** The brief always ends its Index part with
`Connections: <link>`. The link is `https://agents.edgecity.live/insights`
unless `AV_CONNECTIONS_URL` (process environment, else `$HERMES_HOME/.env`)
parses as an `https` URL with no user name or password; anything else is
ignored and the default is used.

**What a roll does to the jobs.** The installer edits each existing job in
place, one `hermes cron edit <id>` for its shape (prompt, script, agent mode,
failure target), so ids, schedules, pause state and next run are kept and
nothing is paused or recreated. The edit takes effect on the job's next run;
the gateway restart is not needed for it. Prompts are compared and sent with
trailing whitespace trimmed (`cron create` strips them), so a second roll
changes nothing. The resident-facing jobs are edited before the 02:00
prefetch (the prefetch edited and the brief not would leave the old brief
prompt with nothing to send), and every job is attempted even after one
fails. The installer then prints one line, `Index crons: N failed (<job
names>)`, runs its other steps, and still exits 0: the control plane stops a
roll at any non-zero exit, before it restarts the gateway or records the
overlay commit, and never reaches the residents after it. Instead:
- every install run writes `$HERMES_HOME/av-events/install-status.json`
  (temp file and rename, mode 0600):
  `{"version": 1, "at": "<UTC ISO time>", "cron_failed": ["<job name>", ...]}`,
  with an empty list when nothing failed, so a clean run clears an earlier
  failure;
- a run with failures prints exactly one fixed line to stdout,
  `agentvillage-install: cron_failed=<count>`, followed by a warning naming
  the jobs.

The control plane does not read the status file or the line yet; look for the
line in the roll's install output. Rerun the install on that resident.
`reconcile_digest_crons.ts`, the operator's tool, exits non-zero when a job
fails.

**After a roll, on a canary.** Force the brief within the window with
`hermes cron run <id>` (the daily digest's id from `hermes cron list`): one
Telegram message, `cron.run` completed and delivered, `message.out` with
channel cron, no `tool.call` in that session, and a `woke` line in
`triggers.jsonl`. A second forced run the same day prints `done-today` and
sends nothing; a run after 11:00 IST prints `outside-window`.

**Rolling back to a release from before DATA-314.** The older installer only
rewrites prompts: it never clears a job's script or turns `no_agent` off, and
the six jobs would keep running the new triggers under the old prompts (the
02:00 job would stay a silent prefetch, so no brief would be staged). Before
the rollback roll, on each resident, for each of the six jobs (ids from
`hermes cron list`):

    hermes cron edit <id> --agent --script ""

What that does: `--script ""` clears the job's pre-run script and `--agent`
turns `no_agent` off, so each of the six is a plain agent job. Until the
rollback roll lands, every run of one is a model turn (it costs tokens) on
the job's current prompt with no Script Output block above it. The five
resident-facing prompts then reply exactly `[SILENT]`, so Hermes delivers
nothing: no brief, drop, follow-up or evening note goes out in that time.
The 02:00 job has no delivery target, which Hermes treats as `local`: its
reply is kept in the job's local output and never reaches the resident's
chat. Its prompt (`PREFETCH_PROMPT` in `install/install_index.ts`) ends by
telling a model that reads it to reply exactly `[SILENT]`, so that reply is
`[SILENT]` too; on a tenant still on a build before B1-fix the prompt lacks
that line and the model writes a sentence into that local output instead.
Then roll the previous tag as usual; its installer rewrites only prompts,
which restores its own (`prepare.md` and `send.md` come back with its files).
The `--failure-deliver local` setting, the shims in `$HERMES_HOME/scripts/`,
`av-events/proactive/`, the `timezone`, `cron.script_timeout_seconds` and
`cron.wrap_response` (false) keys, and the `proactiveRuns` key in the state
file are left behind. All but `cron.wrap_response` are harmless to the older
release: after a rollback to a tag from before DATA-373, whose prompts carry
no manage line, run `hermes config set cron.wrap_response true` on each
resident (or delete the key) so Hermes's own stop-or-manage footer comes back.
Resident holds in `av-events/job-holds.json` are left behind too. The control
plane owns that file and keeps honouring them, so a message a resident
stopped stays stopped; after a rollback to a tag from before DATA-376 the
agent can no longer restart it, and an operator resumes it with the control
plane's job resume route.

## Edge India knowledge (K1)

The agent answers Edge City India background questions (housing, getting
there, visas, tickets, meals, health and safety, residencies, themes) from a
local copy of the published guide, never by fetching inside a resident's turn.
The guide is the upstream indexer's output (the wiki, the website and the
Substack newsletter in Markdown), published in `p2p-lanes/edge-agent-skill`
(branch `main`), directory `references/`. Agents never read it from there by
default: the built-in default is **Edge City's mirror in this repo**,
`skills/edge-india/references/` (`https://raw.githubusercontent.com/Edge-City/agentvillage/main/skills/edge-india/references/manifest.json`),
kept by `sync-edge-india-references.yml` (#203), which copies complete
snapshots only and writes `SNAPSHOT.json` with each file's sha256 and the
upstream commit it copied. The mirror is not reviewed by a person: the
workflow forwards upstream `main` every 15 minutes. What it adds is its
checks (complete trees, the caps this job and `refs.ts` apply, manifest
links only to the guide's own sites), a commit per change under our org's
audit log, and a kill switch (disable the workflow, or revert the mirror). A
push to upstream read directly would reach every agent within one run with
none of these.

**Trust boundary.** The decision: Carter's choice of upstream (GRANT
2026-10-06 09:06Z named `aromeoes/edge-agent-skill`; moved to
`p2p-lanes/edge-agent-skill` on 2026-10-07 under DATA-393, after the aromeoes
indexer had failed every run since 2026-10-01 and Fran's live indexer was found
in `p2p-lanes`, the EdgeOS org, where he said on 2026-10-06 the references live).
The mirror follows `p2p-lanes/edge-agent-skill@main`: an org branch written by
Fran's AWS publisher (CodeBuild, committer `edge-india-indexer[bot]`, commits
unsigned), unpinned, forwarded automatically every 15 minutes by the sync
workflow, with no person reviewing it. What protects the fleet: the sync's checks (sizes,
names, encoding, HTML, complete India-only trees, manifest links only to the
guide's hosts) and the upstream commit it records in `SNAPSHOT.json` per
publish (it refuses to publish when that commit cannot be read); this job's
verification of every file against the mirror's `SNAPSHOT.json`; the stored
record `refs.ts` checks before it reads the local copy (regular files, UTF-8,
sha256 per file); `refs.ts`'s treat_as frame with a per-run token; and the
host allowlist on manifest urls. What is **not** protected: the content
itself. A sentence changed upstream (a price, a date, a contact, a false
claim) reaches residents as information, typically within the hour (the
15-minute sync, the CDN's 5-minute cache, the job's 30-minute period), cited
with its source link. Neither switch removes a
copy already on disk: disabling the workflow, or writing a tenant's key empty,
leaves that tenant's last synced set in place; only a revert of the mirror
pushes a clean copy out, within about 35 minutes (one 30-minute period plus
the CDN's 5-minute cache). The upstream (`p2p-lanes/edge-agent-skill`) stays on
the allowlist as an operator override only. The mirror serves from the merge
of #203 (superseded by the rc15 merge PR); before that every run failed
`http-404` (exit 1, local notice). The mirror's sync refuses any tree this job
would refuse (its path rule, document count and text check are imported from
`knowledge-sync.ts`), and `skills/edge-india/scripts/tests/mirror-consistency.test.ts`
runs this job against the committed tree at the default URL.

**The job.** `Edge — knowledge sync`, installed and reconciled with the
Index jobs (same list, `install/install_index.ts`): every 30 minutes on a
per-tenant offset in the first 30 (`m,m+30 * * * *`; `KNOWLEDGE_SYNC_CRON` /
`--knowledge-sync-cron` override it), `no_agent` (no model, no tokens), no
delivery target, failures to `local`. A roll edits it in place like the
others, so a resident's or admin's pause and schedule are kept. It runs
`$HERMES_HOME/scripts/agentvillage_knowledge_sync.sh`, which runs
`skills/edge-india/scripts/knowledge-sync.ts`:
- fetches the manifest, `index.md` beside it and every file the manifest lists
  (relative `.md` paths only), all from the manifest's own directory;
- accepts only https, no credentials, port, query or fragment, on
  `raw.githubusercontent.com` under `/p2p-lanes/edge-agent-skill/` or
  `/Edge-City/`, or on a host listed in `KNOWLEDGE_SNAPSHOT_HOSTS`
  (comma-separated host names; it never widens `raw.githubusercontent.com`);
  a redirect is followed (at most 3) only to a URL that passes the same check;
- requires a text type (`text/plain` or `text/markdown`; `application/json` too
  for the manifest), UTF-8 with no NUL, and no HTML page; 2 MB a file, 20 MB in
  all, 20 s a fetch, 90 s a run;
- writes the whole set into `$HERMES_HOME/knowledge/edge-india/` (with
  `_sync.json`: source, manifest sha256, ETag, files, each document's manifest
  `hash` as fetched, `fetched_at` = when this content was written,
  `checked_at` = the last run that confirmed it current; and `SNAPSHOT.json`,
  the record it verified the set against: the mirror's own, or, from a source
  that serves none, one written from the fetched bytes) by building it in a
  temp directory and renaming it in; the set it replaces is kept as
  `$HERMES_HOME/knowledge-prev/edge-india/`, outside `knowledge/`. Any failure
  leaves the current set as it was. An unchanged manifest (304 to the stored
  ETag, or the same sha256) rewrites only `checked_at`, and only while the set
  on disk is intact (every file a regular file matching the stored
  `SNAPSHOT.json`); a changed, symlinked or missing file, or a set with no
  stored record, is fetched again in full. `refs.ts` reads the copy only while
  it passes that check (and is valid UTF-8), and otherwise reads the installed
  snapshot and says why in `refs.ts status`. The skill warns that
  the guide may be out of date when `checked_at` is over a day old;
- treats a mixed snapshot (one URL still served from an older commit by the
  CDN, `max-age=300`) as `incomplete`: nothing is written and the ETag and
  sha256 are not advanced, so the next run fetches it all again. When the
  manifest's directory serves `SNAPSHOT.json` (the mirror does), the manifest
  and every fetched file must match its sha256 (`snapshot-mismatch`; a
  malformed `SNAPSHOT.json` fails the run as `bad-snapshot`). Without one, the
  fallback: a document whose manifest `hash` changed but whose URL still
  serves exactly the stored bytes (`stale-document`);
- logs one line per run to `$HERMES_HOME/av-events/knowledge/sync.jsonl`:
  `{"v":1,"event":"knowledge_sync","status":"ok|unchanged|failed|incomplete|unconfigured|skipped","reason":"<code>","files":n,"bytes":n,"sha256":"<manifest sha256>","fetched_at":"<the run's UTC time>"}`,
  plus `"path"` (the stale document's manifest path) on `incomplete` (codes,
  counts and that path only; rotated to `.1` at 1 MB), and prints only the
  wake line `{"wakeAgent": false, ...}`, so Hermes delivers nothing. A
  `failed` or `incomplete` run exits 1: Hermes records it, and its notice
  stays local. A run that finds another one holding the lock (a manual
  `hermes cron run` overlapping a scheduled one) logs `skipped locked` and
  exits 0. A run cut off by its 90 s budget logs `budget`; a single fetch
  past its 20 s logs `timeout`.

**The tenant env.**

| Variable | Meaning |
|---|---|
| `KNOWLEDGE_SNAPSHOT_URL` | The snapshot's manifest. No line: the built-in default, the Edge City mirror `https://raw.githubusercontent.com/Edge-City/agentvillage/main/skills/edge-india/references/manifest.json`. The upstream (`https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json`) is an operator override only. Written empty (`KNOWLEDGE_SNAPSHOT_URL=`): switched off; every run is `unconfigured`, exits 0 and writes no knowledge file. Any other value must pass the allowlist above. |
| `KNOWLEDGE_SNAPSHOT_HOSTS` | Optional. Extra host names a snapshot may be served from. No line: none. |

The script reads both from `$HERMES_HOME/.env` (the file the control plane
writes) on every run, so a changed line takes effect at the next run with no
gateway restart. When `.env` exists it is the only source: a key it does not
carry means the default, whatever the process environment holds (a job's
environment is the gateway's from its start, so a deleted line would
otherwise live on until a restart). The process environment counts only when
there is no `.env` at all. **To switch the sync off, write the key empty
(`KNOWLEDGE_SNAPSHOT_URL=`); deleting the line brings back the default.**
The control plane does not write either key yet: its env write
(`writeIngestEnv` in `control-plane/src/tenants.js`) carries a fixed key set.
Follow-up for the control-plane repo: add `KNOWLEDGE_SNAPSHOT_URL` (and
`KNOWLEDGE_SNAPSHOT_HOSTS` when set) from a control-plane variable of the same
name to that write; to switch the sync off, write the key empty, and leave
the line out only to mean the default. Until it ships, the default applies
and an override or a switch-off is a line set by hand per tenant.

**The skill.** `skills/edge-india/SKILL.md` (skill `edge-india-2026`) tells
the agent to read `knowledge/edge-india/index.md` and the files it links,
never to fetch, to cite each fact's source link as the document carries it,
to prefer newer dated items, and to take times, session venues, attendees and
RSVPs from `edgeos` only. Its `refs.ts` searches and reads the newer of
`knowledge/edge-india/` (age: `checked_at`) and the installed snapshot, and
never fetches unless `AV_INDIA_REFS_LIVE=1` (off by default). With no local
copy it says so and answers from what it knows, without fetching. `workspace/AGENTS.md` routes India background to
it.

**After a roll, on a canary.** With no `KNOWLEDGE_SNAPSHOT_URL` line (the
default) or one set, force a run
with `hermes cron run <id>` (the knowledge sync's id from `hermes cron list`):
a `status: "ok"` line in `av-events/knowledge/sync.jsonl` and
`knowledge/edge-india/index.md` present; a second forced run logs
`unchanged`, and `checked_at` in `knowledge/edge-india/_sync.json` moves to
that run's time. Nothing reaches the resident's chat. `cron.run` events for
this job carry `job_name` `Edge — knowledge sync`: the name is in the
av-events seed `cron_job_names.json` from `cron_job_names_v2`. That is a
seed change: roll the release that first carries it with
`allow_seed_change` ticked, and only after the data pipeline's release
carries `cron_job_names_v2` (until then ingest quarantines the name as
`vocabulary_unknown`).

## The data pipeline

Ingest and dbt have a **Deploy** button in `agentvillage-data` (Actions >
Deploy, run from `main`; `ref` defaults to `main`, `rollback` goes back to an
ancestor of `release` or a `release-YYYY-MM-DD` tag). It runs that repo's full
suite at the target commit, then moves `release` in one push leased on the
commit it planned from, and tags it. Whenever `release` ends at the target, a
read-only check (`bun run migrate:check`, no approval) reads the database.
The apply (`bun run migrate`, in the `production` environment, where a
reviewer may be required) runs only when a migration is pending. Without the
`RAILWAY_TOKEN` secret the run prints the hand commands instead. A rollback
never runs a down migration. dbt builds hourly from the same `release`, so its
next run is the first on the new code.

Until the button's pre-flight is done (two GitHub environments limited to
`main`, the Railway token on both, a deploy key for the first run), the hand
procedure applies: a fast-forward push of `release` to a commit on `main`,
never a reset or a blind force, then migrations run from inside the ingest
container. The detail, the compatibility check and the manifest are in that
repo's `docs/release-process.md` and `docs/runbook.md` ("Deploy ingest and
dbt").

Order when a change spans components: data pipeline first, then the overlay
tag and roll, then the manifest PR recording what is live.

## What the records give research

- **Per resident, per version:** every creation, go-live and roll writes a
  control-plane event (`tenant.created`, `tenant.live`, `tenant.updated`) into
  the research database with the overlay tag and the base image name in its
  payload. Which agent version a resident ran, and from when, is reconstructed
  from those.
- **Per service release:** the dated `release-*` tag and the Deploy run. No
  event is emitted; service code does not change agent behaviour.
- **Per roll:** the GitHub Deployment under `residents`, with per-resident
  statuses.
- **Known gap:** every event has an `overlay_ref` column meant to carry the tag
  per event, and it is empty because the VM environment never sets it. Events do
  carry `hermes_version`. Until the environment fix ships, attribute events to a
  version by joining on the resident's latest `tenant.updated`.

## Who can do what

| Step | Who |
|---|---|
| Merge to `main` after review | whoever the repo's merge rule names |
| Deploy the control plane or landing | anyone with write access to that repo, with a group-chat line |
| Tag this repo (the Tag release button, or by hand) | anyone with write access here |
| Roll residents | anyone with write access to the controlplane repo, through the staged procedure |
| Release ingest, run migrations | the data owner |
| Change a Railway variable or setting | a Railway admin, stating the exact change first |
| Record the release in the manifest | a PR to `agentvillage-data` after the fact |

Repository secrets are readable by any workflow on any branch, so everyone
with write access to the controlplane repo effectively holds the Railway token
and the control-plane API key. Keep that writer list short.

## Where the detail lives

- `Edge-City/agentvillage-controlplane/docs/ROLL.md`: the Roll button's full
  manual (verification table, every refusal, resume, limits).
- `Edge-City/agentvillage-controlplane/docs/DEPLOY.md`: the Deploy button's
  manual.
- `Edge-City/agentvillage-controlplane/docs/CHECKPOINT_AGENTVILLAGE_BASE.md`:
  rebuilding the base image new tenants boot from. Manual, outside both buttons,
  and not needed to refresh existing residents.
- `Edge-City/agentvillage-data/docs/release-process.md`: the data pipeline's
  release, the manifest and the compatibility check.
- `Edge-City/agentvillage-data/docs/runbook.md`, "Staged rollout via Roll":
  the operator's step-by-step with the exact queries for the Telegram check and
  the 48 hour gate.

## For non-hosted installs

A bring-your-own-agent install has no control plane. After copying updated
files, run `HERMES_HOME=<resident-home> bun install/reconcile_digest_crons.ts`
so cron prompts match the files (see the README's "Change a cron prompt" row).

## Edge City authentication and local verification

`dashboard-auth-edgecity` is the existing owner-email OTP provider; do not install
a second identity layer. Its control-plane send/verify/authorize endpoints require
a live tenant and current owner. Configure the scoped EdgeOS third-party app key
and tenant ID on CP, not as an agent automation key.

The same plugin accepts the archive job's per-tenant `archive_read` bearer on
`GET /api/sessions` and `GET /api/sessions/<id>/messages` only, verified against
`AV_ARCHIVE_READ_HASH` in the sandbox's `.env` (DATA-88); see
`plugins/dashboard-auth-edgecity/README.md` for scope and rotation.

Sessions now use private per-home SQLite storage and a durable tenant-specific
signing key. Preserve that storage with the tenant's home during restart/restore.
Do not distribute a shared `HERMES_DASHBOARD_SESSION_SECRET`: the provider does
not use it. Tokens are tenant-bound, logout revokes the family, refresh rotates
once with replay invalidation, and the original 30-day expiry cannot be extended.
CP ownership/suspension is rechecked; independent EdgeOS account revocation is
not promised to propagate immediately. Existing pre-cutover sessions require login.

For the workspace's real local agent, the installer supports
`--no-restart --skip-crons --skip-index`. This stages the normal skills/plugins
without inventing an Index credential or provisioning an external account.
The root launcher isolates `HERMES_HOME`, forces the existing authentication gate
on loopback and keeps local tool approvals enabled. This is not an OS sandbox
or proof of Railway deployment behavior.

Verification exercised genuine local EdgeOS OTP, owner rejection, restart
persistence, logout replay rejection, and six session-security regressions.
Before rollout, repeat the owner/cross-owner/refresh/logout checks on one hosted
staff tenant, then test the supported Desktop client and a real Telegram bot.

