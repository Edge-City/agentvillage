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

If `--skip-crons` is passed to the AgentVillage installer, `--install-cron` is omitted. Normal install does not install Enzyme, run `enzyme init`, run `enzyme refresh`, run `enzyme install hermes`, or print provider secrets.

AgentVillage writes Hermes runtime instructions manually in `workspace/AGENTS.md`. This setup script installs the vault folders, managed Enzyme vault config, non-secret env references, and heartbeat cron. Enzyme `init`/`refresh` only initialize or update the vault index; they do not rewrite AgentVillage runtime instructions.

## Enzyme Env

Enzyme v0.6 uses hosted credits/auth by default for `enzyme init` and `enzyme refresh`. That hosted/default path may require an interactive `enzyme login` before `enzyme refresh` succeeds. Ambient provider keys are used only when `--use-env-llm` is passed intentionally.

Supported provider env families:

- `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, optional `OPENROUTER_MODEL`
- `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `OPENAI_MODEL`

Resolution order is process env, `<root>/.env`, `$HERMES_HOME/.env`, then `~/.hermes/.env`. Only those names are read. `memory/enzyme-env.sh` stores references and non-secret defaults only.

Hosted Hermes may have Enzyme at `$HERMES_HOME/.local/bin/enzyme` or `/opt/data/.local/bin/enzyme`. AgentVillage install adds those locations to Hermes terminal PATH, and `memory/enzyme-env.sh` adds the same non-secret PATH entries for manual operator shells.

Secret-safe check:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --check-enzyme-env
```

Check index status:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --run-enzyme status
```

For hosted AgentVillage operators, first verify provider env presence without values, then initialize or refresh with ambient provider keys only when intended:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --check-enzyme-env
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --run-enzyme init --use-env-llm
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --run-enzyme refresh --use-env-llm
```

Use direct Enzyme commands when runtime/tooling exposes shell access:

```bash
enzyme catalyze -p agent-memory-vault -n 8 "what's going on in the forum"
enzyme petri -p agent-memory-vault -n 12
```

For broad forum/chat catch-up prompts, run retrieval first when available, then open/verify cited paths or live tools before answering. Agents can use Enzyme directly only when their runtime/tooling exposes it. Otherwise, read the materialized `agent-memory-vault/forum/`, `agent-memory-vault/irl/`, `USER.md`, `MEMORY.md`, and live canonical tools/files. Do not overclaim: if retrieval was not run, say the answer comes from fallback distilled notes/live files. Do not run `enzyme install hermes` as part of normal rollout; AgentVillage owns the runtime instruction surface in `workspace/AGENTS.md`.

## Secret Scan

Rendered sessions are redacted before writing, but operators should still scan after rendering or before rollout. The scan reports counts, kinds, and file paths only; it never prints matching lines or values:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --scan-vault-secrets
```

To include operational `memory/*` files in the same secret-safe report:

```bash
python3 skills/index-network/scripts/memory-workspace/setup_workspace.py --scan-vault-secrets --scan-include-memory
```

The session rendering wrapper also supports a post-render check:

```bash
python3 skills/index-network/scripts/memory-workspace/render_vault_sessions.py \
  --root "$HERMES_HOME" \
  --input "$HERMES_HOME/sessions" \
  --scan-output-secrets
```

## Retrieval Policy

`forum/` and `irl/` are agent-written distilled observations. They are useful for memory retrieval, ranking, copy, and follow-up questions, but they are not user-authored statements and must not be treated as direct evidence that the user said, wants, or believes something. Before creating durable Index records or saying "the user said/wants", verify the claim against `USER.md`, `MEMORY.md`, a direct user transcript, or another canonical live source.

`hermes/sessions/` remains indexed as transcript provenance/evidence, but rendered sessions carry `source_surface`, `session_kind`, and `retrieval_weight` frontmatter. Down-rank or ignore `session_kind: operator_validation` and `session_kind: debug_validation` unless explicitly auditing historical validation/debug work.

## Cron

The installed cron is `Hermes agent memory heartbeat`, with no delivery target. Hermes cron scripts must live under `~/.hermes/scripts/` and be referenced by filename, so setup writes a small wrapper at:

```text
$HERMES_HOME/.hermes/scripts/agentvillage-memory-workspace-cron_prepare.py
```

That wrapper runs `skills/index-network/scripts/memory-workspace/cron_prepare.py` from the Hermes root. `cron_prepare.py` renders Hermes sessions, prepares bounded context, and asks the cron agent to update forum/IRL vault notes. The cron prompt then asks the agent to run:

```bash
python3 skills/index-network/scripts/memory-workspace/workspace_loop.py --prepare
```
