# Deployment: how a change in this repo reaches a running resident

This repo is the **overlay**: the skills, workspace files, installer and `plugins/av-events` that every hosted resident's sandbox clones. Merging to `main` (or `goa`) changes **no running resident**. A resident only picks up new code when the control plane rolls it, and the control plane rolls whatever `EDGE_HERMES_REF` names.

## The three pieces

| Piece | Where | What it does |
|---|---|---|
| `EDGE_HERMES_REF` | Railway variable on the `control-plane` service (project `agentvillage-goa`) | The git ref (tag, branch or commit) of this repo that new sandboxes clone and that a roll moves existing sandboxes to. Should always be a **release tag**, never a branch. |
| `POST /tenants/:id/update` (and `/tenants/update-all`) | control-plane API, fleet key | Syncs one sandbox's overlay checkout to `EDGE_HERMES_REF`, reruns the installer, restarts the gateway. |
| `releases/manifest.yaml` | `Edge-City/agentvillage-data` | The record of what is live across every component, changed by PR. The promote script applies it. See [release-process.md](https://github.com/Edge-City/agentvillage-data/blob/main/docs/release-process.md). |

## Rolling out a change (contributor view)

1. Merge your PR to `main` as usual. Nothing is live yet.
2. Cut a tag on the merge commit: `git tag v2.0.0-rc4 <sha> && git push origin v2.0.0-rc4`. Tags are never moved.
3. Open a manifest PR on `agentvillage-data` that sets `overlay.ref` and `plugin.ref` to the new tag. CI checks the tag out and runs the ingest suite against the plugin's seed files; a seed mismatch fails the PR.
4. When it merges, whoever holds the fleet key runs the promote script (`bun run release:promote`, dry run by default; `--apply` moves the pointer and rolls tenants one at a time, dogfood tenants first, stopping on the first failed health check).

Until the promote script is in use, steps 3–4 are done by hand and are Carter's or Seref's:

```bash
# 1. point new and rolled sandboxes at the tag (Railway redeploys the control plane)
railway variables --set "EDGE_HERMES_REF=v2.0.0-rc4" --service control-plane
# 2. roll one tenant, check it, then the rest
curl -X POST "$CP_URL/tenants/<tenant-id>/update" -H "Authorization: Bearer $CP_API_KEY"
```

## Rules

- **Never point `EDGE_HERMES_REF` at a branch.** A branch moves under running tenants and makes "what is live" unanswerable. The pin to `v2.0.0-rc3` on 2026-09-25 replaced the `goa` branch for exactly that reason.
- **Roll one tenant first.** A bad overlay breaks every gateway it reaches; the first tenant rolled should be a staff (dogfood) tenant.
- **Seed files are a contract.** `plugins/av-events/{tool_categories,edgeos_tool_allowlist,cron_job_names}.json` are mirrored byte for byte in `agentvillage-data`. Change them in both repos in the same release, or the ingest suite fails the manifest PR.
- **Old rollout path is gone.** The `post-merge` workflow that used to hit `/hooks/sync` on every push was retired on 2026-09-25 (#144); that route no longer exists.

## For non-hosted installs

A bring-your-own-agent install has no control plane. After copying updated files, run `HERMES_HOME=<resident-home> bun install/reconcile_digest_crons.ts` so cron prompts match the files (see the README's "Change a cron prompt" row).
