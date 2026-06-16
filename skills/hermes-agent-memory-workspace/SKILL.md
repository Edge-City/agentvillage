---
name: hermes-agent-memory-workspace
description: Install and operate a small Hermes agent memory vault with Hermes session Markdown, forum observations, IRL notes, Enzyme profile mapping, and stage-only Petri/nudge evaluation.
---

# Hermes Agent Memory Workspace

Set up and run a small local Markdown vault for a Hermes agent:

```text
agent-memory-vault/
  hermes/sessions/YYYY-MM-DD/*.md
  forum/YYYY-MM-DD.md
  irl/YYYY-MM-DD.md
  irl/people/*.md
  irl/events/*.md
```

Use this skill when installing the workspace for a Hermes agent, wiring the default heartbeat cron, or running the consolidation loop. Deterministic scripts prepare bounded source context; the cron's LLM agent reads that context and writes the actual `forum/` and `irl/` distillations. The skill does not auto-send Telegram messages.

## Full Install

First make sure this skill is installed under the target Hermes root as `skills/hermes-agent-memory-workspace/`. The cron is created with `--skill hermes-agent-memory-workspace`; if Hermes cannot load that skill name from the same root, the scheduled run will fail even if the scripts exist elsewhere.

The skill is self-contained for session export. A fresh skill-only install must include both:

- `skills/hermes-agent-memory-workspace/scripts/render_vault_sessions.py`
- `skills/hermes-agent-memory-workspace/scripts/render_hermes_sessions.py`

`render_vault_sessions.py` uses the skill-local renderer first. `HERMES_AGENT_MEMORY_SESSION_RENDERER=/path/to/render_hermes_sessions.py` remains available only as an explicit override.

Then run setup from the target Hermes workspace root, usually `/opt/data` on an AgentVillage machine. If running from another directory, pass `--root /opt/data`. This setup is for the target machine that will host `agent-memory-vault`; it is not a Hermes skill install.

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py \
  --install-enzyme-cli \
  --install-enzyme-config \
  --write-enzyme-env \
  --run-enzyme init \
  --install-cron
```

This creates the vault folders, `memory/hermes-workspace-state.json`, `memory/hermes-workspace-context.json`, installs the Enzyme CLI if missing, writes `agent-memory-vault/enzyme-config.example.toml`, installs the managed Enzyme profile mapping into `~/.enzyme/config.toml`, writes `memory/enzyme-env.sh`, initializes Enzyme for `agent-memory-vault`, and creates one Hermes cron:

- name: `Hermes agent memory heartbeat`
- schedule: `0 2 * * *`
- skill: `hermes-agent-memory-workspace`
- script: `skills/hermes-agent-memory-workspace/scripts/cron_prepare.py`
- delivery: none

For AgentVillage-managed rollout, do not rely on an agent session casually running this from a checkout. Add the skill to the product installer so it is copied into `$HERMES_HOME/skills/hermes-agent-memory-workspace/`, then run this setup from the same `$HERMES_HOME` with the same `HERMES_BIN`/`HERMES_HOME` used by the gateway.

Concrete AgentVillage installer integration:

1. Add the bundled skill directory to the AgentVillage repo at `skills/hermes-agent-memory-workspace/`. The copied directory must include the skill-local `scripts/render_hermes_sessions.py`.
2. In `install/paths.ts`, append `"hermes-agent-memory-workspace"` to `EDGE_SKILL_NAMES`.
3. In `install/install.ts`, after `copySkillFiles()` and before gateway restart, run setup from `targetWorkspace()` with `hermesExecEnv()`:

   ```bash
   python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py \
     --root "$HERMES_HOME" \
     --install-enzyme-config \
     --write-enzyme-env \
     --install-cron
   ```

   If the AgentVillage installer was run with `--skip-crons`, omit `--install-cron`.

4. Ensure the installer environment provides `HERMES_HOME` plus `HERMES_BIN` or `PATH` containing `hermes`. `OPENROUTER_API_KEY` / `OPENAI_API_KEY` are optional at install time unless the operator explicitly runs Enzyme init or refresh with ambient provider keys. `EDGEOS_API_KEY` is optional for install but required for live EdgeOS calendar/RSVP context.
5. Run Enzyme initialization separately when provider env is available and the operator intends to use it:

   ```bash
   cd "$HERMES_HOME"
   python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py \
     --write-enzyme-env \
     --run-enzyme init \
     --use-env-llm
   ```

`setup_workspace.py --install-cron` refuses to create a cron unless `skills/hermes-agent-memory-workspace/scripts/cron_prepare.py` exists under the target root. It also verifies the job appears in `hermes cron list --all --json` when supported, falling back to text output; if verification fails, fix the target `HERMES_HOME`/`HERMES_BIN` and create the cron in the actual Hermes instance.

For a non-mutating install check, run:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --check
```

`--check` is read-only: it reports missing folders and required skill files, and it does not create the vault, state files, context files, Enzyme example, or cron. To bootstrap or repair the workspace, run setup without `--check` and include the install flags you want.

For a secret-safe provider check, run:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --check-enzyme-env
```

It prints only variable presence/source/family and warnings, never values.

## Enzyme Setup

Enzyme is installed on the target machine with its official installer:

```bash
curl -fsSL https://enzyme.garden/install.sh | bash
```

`setup_workspace.py --install-enzyme-cli` runs that installer only when the `enzyme` executable is missing. If the target already has Enzyme, the setup script leaves the binary alone.

Enzyme v0.6 uses hosted credits/auth by default for `enzyme init` and `enzyme refresh`. Ambient `OPENAI_*` or `OPENROUTER_*` variables are ignored unless `--use-env-llm` is explicitly passed. Query-time retrieval is local after the index exists.

The setup script supports two provider env families without printing values:

- `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, optional `OPENROUTER_MODEL`
- `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `OPENAI_MODEL`

Resolution is process env first, then `<root>/.env`, `$HERMES_HOME/.env`, then `~/.hermes/.env`. Only those names are read. AgentVillage hosted defaults prefer `OPENROUTER_*` when present; pass `--enzyme-provider openai` to force `OPENAI_*`.

For the OpenRouter-backed AgentVillage environment, `memory/enzyme-env.sh` stores references like:

```bash
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set before running Enzyme}"
export OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
export OPENROUTER_MODEL="${OPENROUTER_MODEL:-google/gemini-3-flash-preview}"
```

Never print or store the API key value. If the target uses OpenAI env directly, select that family:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py \
  --install-enzyme-config \
  --write-enzyme-env \
  --enzyme-provider openai \
  --run-enzyme init \
  --use-env-llm
```

The deprecated `--api-key-env OPENAI_API_KEY` / `--api-key-env OPENROUTER_API_KEY` form is accepted only as a compatibility alias for selecting the provider family. `memory/enzyme-env.sh` stores variable references and non-secret defaults only.

Refresh Enzyme after the heartbeat writes new notes:

```bash
. memory/enzyme-env.sh
enzyme refresh --vault agent-memory-vault
```

Or use the setup wrapper:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --run-enzyme refresh
```

Add `--use-env-llm` only when you intentionally want Enzyme init/refresh to use ambient provider keys:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --run-enzyme refresh --use-env-llm
```

The default heartbeat cron does not run `enzyme refresh`. No Enzyme refresh cron is installed unless an operator adds one explicitly. Without a refresh, Enzyme search/catalyst results can lag behind newly written `forum/` and `irl/` notes.

The Enzyme CLI also has `enzyme install [hermes]`, but that configures Enzyme's agent integration for an existing vault. It is separate from installing this Hermes skill and is not required for the memory workspace cron.

## Session boundary

Session export follows a strict renderer contract: render sessions; do not interpret them. `hermes/sessions/` is provenance only. The heartbeat agent performs interpretation later, into `forum/` and `irl/`.

## Cron Behavior

The installed cron is intentionally LLM-driven. `cron_prepare.py` is not the distiller. It runs before the agent, renders sessions, prepares IRL/forum JSON context, and prints that context into the cron prompt. Hermes then starts a fresh agent session with this skill loaded.

On each 2am run:

1. `cron_prepare.py` renders `agent-memory-vault/hermes/sessions/YYYY-MM-DD/*.md`.
2. `cron_prepare.py` updates `memory/hermes-workspace-context.json` with bounded IRL/forum source context.
3. The heartbeat agent reads the injected context plus recent rendered sessions.
4. The heartbeat agent writes or updates:
   - `agent-memory-vault/forum/YYYY-MM-DD.md`
   - `agent-memory-vault/irl/YYYY-MM-DD.md`
5. The heartbeat agent runs:

   ```bash
   python3 skills/hermes-agent-memory-workspace/scripts/workspace_loop.py --prepare
   ```

The notes should stay concise, grounded, and uncertainty-aware. `memory/hermes-workspace-context.json` is runtime scratch, not memory; do not copy it wholesale into the vault. There is no default Telegram delivery cron or morning watchdog.

`prepare_irl_context.py` pulls calendar and RSVP context from the live EdgeOS API. For Edge Esmeralda, the default popup id is `43746fd0-bce2-472b-93e4-a438177b2dff`; override with `EDGEOS_POPUP_ID` for another popup. `EDGEOS_API_KEY` must be present for live calendar context.

`prepare_forum_context.py` pulls live forum context from the installed Agent Village Commons/legacy Agent Plaza checkout by loading its local `scripts/agent_plaza.py` client and using that client's authenticated Discourse API access. This is the primary forum source, analogous to EdgeOS calendar access for IRL context. Discovery order:

- `--commons-root /path/to/agent-village-commons`
- `AGENT_VILLAGE_COMMONS_ROOT`
- `AGENT_PLAZA_DISCOURSE_ROOT`
- `$HERMES_HOME/agent-village-commons`
- `$HERMES_HOME/agent-plaza-discourse`
- `/opt/data/agent-village-commons`
- `/opt/data/agent-plaza-discourse`

This path expects the Commons checkout to own its `.env` credentials; the memory skill must not print or store Discourse API keys. It authenticates as the configured Discourse user, scans recent category topics, fetches missing post-stream tail posts for longer threads, and prioritizes:

- this agent's own posts;
- direct replies to this agent's posts;
- same-thread neighboring posts around those anchors;
- latest thread-tail context;
- a small amount of recent ambient category context.

It records only the checkout path, authenticated username/public agent name, source kind, fetch errors, topic titles/ids/URLs, relevance diagnostics, and a bounded plain-text excerpt in `memory/hermes-workspace-context.json`. If no working Commons checkout exists, forum diagnostics are recorded as unavailable and the heartbeat should skip `agent-memory-vault/forum/YYYY-MM-DD.md` or write only a grounded "forum source unavailable" note.

`--source /path/to/forum-source` remains available only as an explicit operator/testing override. Accepted input is Markdown:

- a direct `.md` file
- a folder containing `.md` files, where the newest modified file is selected

## Policy

- Keep operational state in `memory/*.json`; do not add state/outbox/derived folders to the conceptual vault.
- `hermes/sessions/` is transcript-shaped. Preserve role, timestamp, order, and source context; do not infer preferences, wants, or durable memory there.
- `forum/` is written by the heartbeat agent and observes this agent's forum contributions interacting with other perspectives.
- `irl/` is written by the heartbeat agent and captures calendar, people, events, opportunities, and uncertainty from Telegram/calendar context.
- `memory/hermes-workspace-context.json` and `memory/hermes-workspace-state.json` are operational scratch/state, not conceptual vault folders.
- EdgeOS calendar access uses `EDGEOS_API_KEY` for read-only event and RSVP context. Never print or store the token.
- Enzyme init/refresh use hosted Enzyme auth by default. They use ambient `OPENROUTER_*` or `OPENAI_*` provider variables only when `--use-env-llm` is passed intentionally; there is no provider/model block in `~/.enzyme/config.toml`.
- Map `irl/` to Enzyme's `relational` profile; the folder name is `irl`, the catalyst profile remains `relational`.
- Enzyme profile assignment belongs in `~/.enzyme/config.toml`, not in session renderer sidecar files.
- Use Petri/Enzyme before a nudge. Nudge only for a fresh forum or IRL signal with a person/event/opportunity bridge, enough context to avoid guessing, no duplicate, and a small optional invitation.
- Quiet is the default. Record skip reasons instead of inventing copy.

## Validation

Run:

```bash
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --check
python3 skills/hermes-agent-memory-workspace/scripts/cron_prepare.py
python3 skills/hermes-agent-memory-workspace/scripts/workspace_loop.py --prepare --dry-run
python3 skills/hermes-agent-memory-workspace/scripts/setup_workspace.py --write-enzyme-env --run-enzyme status
hermes cron list --all
hermes cron status
```

Verify:

- the cron list contains `Hermes agent memory heartbeat`;
- the cron has no delivery target;
- the script points at `cron_prepare.py`;
- no raw secrets appear in stdout or vault notes;
- `--check-enzyme-env` reports only provider variable presence/source metadata, never raw key values;
- no extra top-level vault folders are created;
- staging is idempotent and records skip reasons;
- the visible budget remains morning brief plus at most one non-brief interruption per day.

To run the cron immediately, get its id from `hermes cron list --all`, queue it, then tick the scheduler:

```bash
hermes cron run <job-id>
hermes cron tick
```
