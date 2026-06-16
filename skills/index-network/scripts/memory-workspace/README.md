# AgentVillage Memory Workspace

AgentVillage-managed Hermes memory infrastructure. This is not a standalone Hermes skill; it is copied with the `index-network` script bundle and installed by `install/install.ts`.

It creates:

```text
agent-memory-vault/
  hermes/sessions/YYYY-MM-DD/*.md
  forum/YYYY-MM-DD.md
  irl/YYYY-MM-DD.md
  irl/people/*.md
  irl/events/*.md
```

Normal AgentVillage install runs:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py \
  --root "$HERMES_HOME" \
  --install-enzyme-config \
  --write-enzyme-env \
  --install-cron
```

If `--skip-crons` is passed to the AgentVillage installer, `--install-cron` is omitted. Normal install does not install Enzyme, run `enzyme init`, run `enzyme refresh`, or print provider secrets.

## Enzyme Env

Enzyme v0.6 uses hosted credits/auth by default for `enzyme init` and `enzyme refresh`. Ambient provider keys are used only when `--use-env-llm` is passed intentionally.

Supported provider env families:

- `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, optional `OPENROUTER_MODEL`
- `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `OPENAI_MODEL`

Resolution order is process env, `<root>/.env`, `$HERMES_HOME/.env`, then `~/.hermes/.env`. Only those names are read. `memory/enzyme-env.sh` stores references and non-secret defaults only.

Secret-safe check:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --check-enzyme-env
```

Initialize or refresh with ambient provider keys only when intended:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --run-enzyme init --use-env-llm
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --run-enzyme refresh --use-env-llm
```

## Cron

The installed cron is `Hermes agent memory heartbeat`, with no delivery target. Hermes cron scripts must live under `~/.hermes/scripts/` and be referenced by filename, so setup writes a small wrapper at:

```text
$HERMES_HOME/.hermes/scripts/agentvillage-memory-workspace-cron_prepare.py
```

That wrapper runs `skills/index-network/scripts/memory-workspace/cron_prepare.py` from the Hermes root. `cron_prepare.py` renders Hermes sessions, prepares bounded context, and asks the cron agent to update forum/IRL vault notes. The cron prompt then asks the agent to run:

```bash
python3 skills/index-network/scripts/memory-workspace/workspace_loop.py --prepare
```
