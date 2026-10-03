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
| Agent content: skills, prompts, installer, the `av-events` plugin | this repo, `Edge-City/agentvillage` | An annotated tag on `main`, then the **Roll** workflow updates every resident's VM to it | The tag; a GitHub Deployment per roll (environment `residents`); a `tenant.updated` event per resident carrying the tag |
| The data pipeline: ingest and dbt | `Edge-City/agentvillage-data` | A hand fast-forward push of its `release` branch; migrations run by hand | The `release` branch tip; `releases/manifest.yaml`, written by PR after the fact |

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
| `scope` | `test-tenants` (default: the canary tenants listed in the `ROLL_TEST_TENANTS` repository variable, one per person who rolls) or `all`. |
| `pause_seconds` | Wait after each resident before checking it. Default 60, minimum 10. |
| `allow_seed_change` | Default off. The data owner's confirmation that ingest already carries changed plugin seed files. |

**Before a roll, by hand.**
1. Tag the merged commit on `main`: `git tag -a v2.0.0-rcN -m "..."` and push
   the tag. Anyone with write access to this repo can.
2. If the tag changes `plugins/av-events/tool_categories.json`,
   `edgeos_tool_allowlist.json` or `cron_job_names.json`, release the data
   pipeline with those seeds first, or the new events are quarantined. The
   button refuses such a tag until `allow_seed_change` is ticked.
3. Make sure your own agent is a canary. Each agent answers only its owner's
   Telegram, so the human check in the procedure below only works on a tenant
   you own. `ROLL_TEST_TENANTS` on the controlplane repo holds one tenant per
   person who rolls; if yours is missing, ask a controlplane admin to add it
   before you start. The dry-run summary lists the canaries, so confirm yours
   is there.
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
   can do this, which is why every roller's tenant is a canary. Then confirm
   its events still arrive in the research database and nothing was
   quarantined (the button cannot see ingest). No reply after a second try:
   roll back.
4. Leave the test tenants on the tag for 48 hours of real use. The readiness
   gates in `agentvillage-data/docs/readiness-checklist.md` are measured over
   them during that time.
5. Dry run then real run with `scope: all`, at a quiet hour for Goa (IST).
   Residents already proven healthy on the tag are skipped.

**When it refuses.** A refusal changes nothing. The common ones: the tag is
lightweight, missing or not on `main`; a branch has the tag's name; seed files
changed without `allow_seed_change`; the control plane is unhealthy or has not
restarted since the variable was set; no test tenant is live; another real roll
is running or a newer roll record exists. Fix the cause and run again.

**When it stops.** The summary names each resident's result: rolled, rejected,
unreachable, busy, outcome unknown, or failed. Check every failed, unknown or
busy resident by hand. To resume, start a new run with the same tag: healthy
residents are skipped and the stopped one is updated again at its normal turn.

**Roll back.** Run the workflow with the previous tag, test tenants first. A
rollback is an ordinary roll and restarts every resident in scope again.

**What Roll does not guarantee.** That the agent answers. That Telegram
messages sent during a restart arrive (Hermes drops them on a cold start; the
installer's `drop_pending_on_cold_boot` fix needs a Hermes build from
2026-09-20 or later in the VM). That events arrive at ingest. A resident's agent
memory: no memory backups run in production yet, so a bad roll has no memory
undo.

## The data pipeline

Ingest and dbt have no button. `release` in `agentvillage-data` is moved by a
hand fast-forward push to a commit on `main`, never a reset or a force.
Migrations run by hand from inside the ingest container after the deploy and
before any roll that depends on them, with a lock timeout on the connection
URL. dbt builds hourly from the same `release`. The detail, the compatibility
check and the manifest are in that repo's `docs/release-process.md` and
`docs/runbook.md`.

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
| Tag this repo | anyone with write access here |
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

