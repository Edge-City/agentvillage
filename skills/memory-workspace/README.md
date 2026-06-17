# AgentVillage Memory Workspace

AgentVillage-managed Hermes memory infrastructure. This is a dedicated infrastructure skill copied to `$HERMES_HOME/skills/memory-workspace/` and installed by `install/install.ts`.

It creates:

```text
memory/
  hermes/sessions/YYYY-MM-DD/*.md
  forum/YYYY-MM-DD.md
  irl/YYYY-MM-DD.md
  irl/people/*.md
  irl/events/*.md
```

Normal AgentVillage install runs:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py \
  --root "$HERMES_HOME" \
  --install-enzyme-config \
  --write-enzyme-env \
  --install-cron
```

If `--skip-crons` is passed to the AgentVillage installer, `--install-cron` is omitted. Normal install does not install Enzyme, run `enzyme init`, run `enzyme refresh`, run `enzyme install hermes`, or print provider secrets.

AgentVillage writes Hermes runtime instructions manually in `workspace/AGENTS.md`. This setup script installs the memory folders, managed Enzyme config, non-secret env references, and heartbeat cron. Existing legacy `agent-memory-vault/` installs are migrated into `memory/` during setup when safe. Enzyme `init`/`refresh` only initialize or update the memory index; they do not rewrite AgentVillage runtime instructions. `enzyme init` is safe as an optional operator bootstrap when provider env exists, even if the vault is still empty. It is not a substitute for later refreshes: after the heartbeat writes new forum/IRL/session markdown, semantic retrieval stays stale until `enzyme refresh` runs manually or the operator explicitly installs the refresh cron.

## Enzyme Env

Enzyme v0.6 uses hosted credits/auth by default for `enzyme init` and `enzyme refresh`. That hosted/default path may require an interactive `enzyme login` before `enzyme refresh` succeeds. Ambient provider keys are used only when `--use-env-llm` is passed intentionally.

Supported provider env families:

- `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`, optional `OPENROUTER_MODEL`
- `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, optional `OPENAI_MODEL`

Resolution order is process env, `<root>/.env`, `$HERMES_HOME/.env`, then `~/.hermes/.env`. Only those names are read. `memory/enzyme-env.sh` stores references and non-secret defaults only.

Hosted Hermes may have Enzyme at `$HERMES_HOME/.local/bin/enzyme` or `/opt/data/.local/bin/enzyme`. AgentVillage install adds those locations to Hermes terminal PATH, and `memory/enzyme-env.sh` adds the same non-secret PATH entries for manual operator shells.

Secret-safe check:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py --check-enzyme-env
```

Check index status:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py --run-enzyme status
```

For hosted AgentVillage operators, first verify provider env presence without values, then initialize or refresh with ambient provider keys only when intended:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py --check-enzyme-env
python3 skills/memory-workspace/scripts/setup_workspace.py --run-enzyme init --use-env-llm
python3 skills/memory-workspace/scripts/setup_workspace.py --run-enzyme refresh --use-env-llm
```

The default heartbeat does not run refresh automatically, because `init`/`refresh` can use hosted credits or ambient provider keys. If a deployment wants automatic freshness, install the explicit provider-gated refresh cron rather than hiding model spend inside the memory heartbeat:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py \
  --root "$HERMES_HOME" \
  --install-enzyme-refresh-cron
```

The AgentVillage installer exposes the same path:

```bash
bun install/install.ts --index-api-key <KEY> --install-enzyme-refresh-cron
```

Default schedule is `30 2 * * *`, after the memory heartbeat default. Override with `--enzyme-refresh-cron "0 3 * * *"` or `ENZYME_REFRESH_CRON="0 3 * * *"`; either schedule override also opts in. Setting `AGENTVILLAGE_ENZYME_REFRESH_CRON=1` also opts in. Invalid cron overrides are ignored with a warning and the default schedule is kept. The refresh runner always uses `--use-env-llm`, never hosted/default unattended auth. It checks provider env by name only, checks that the Enzyme CLI exists, requires at least one generated memory input under `memory/forum/*.md`, `memory/irl/*.md`, or `memory/hermes/sessions/**/*.md`, runs `enzyme init --use-env-llm` when status indicates no index, then runs `enzyme refresh --use-env-llm`. It skips quietly for expected conditions and writes safe status to:

```text
memory/enzyme-refresh-status.json
```

The status file records attempt/success/skipped reason, provider family and env var names only, source counts/mtimes, a SHA256 fingerprint over relative input paths/mtimes/sizes, action return codes, and timestamps. It never stores key values or memory file contents.

Use direct Enzyme commands when runtime/tooling exposes shell access:

```bash
enzyme catalyze -p memory -n 8 "what's going on in the forum"
enzyme petri -p memory -n 12
```

For broad forum/chat catch-up validation, trace order should show direct `enzyme catalyze` before any broad forum glob/file fallback. After retrieval, open/verify cited paths or live tools before answering. Agents can use Enzyme directly only when their runtime/tooling exposes it. Otherwise, read `memory/forum/`, `memory/irl/`, `USER.md`, `MEMORY.md`, and live canonical tools/files. Do not overclaim: if retrieval was not run, say the answer comes from fallback distilled notes/live files. Do not run `enzyme install hermes` as part of normal rollout; AgentVillage owns the runtime instruction surface in `workspace/AGENTS.md`.

## Secret Scan

Rendered sessions are redacted before writing, but operators should still scan after rendering or before rollout. The scan reports counts, kinds, and file paths only; it never prints matching lines or values:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py --scan-vault-secrets
```

To include operational `memory/*` files in the same secret-safe report:

```bash
python3 skills/memory-workspace/scripts/setup_workspace.py --scan-vault-secrets --scan-include-memory
```

The session rendering wrapper also supports a post-render check:

```bash
python3 skills/memory-workspace/scripts/render_vault_sessions.py \
  --root "$HERMES_HOME" \
  --input "$HERMES_HOME/sessions" \
  --scan-output-secrets
```

## Retrieval Policy

`forum/` and `irl/` are agent-written distilled observations. They are useful for memory retrieval, ranking, copy, and follow-up questions, but they are not user-authored statements and must not be treated as direct evidence that the user said, wants, or believes something. Before creating durable Index records or saying "the user said/wants", verify the claim against `USER.md`, `MEMORY.md`, a direct user transcript, or another canonical live source.

`hermes/sessions/` remains indexed as transcript provenance/evidence, but rendered sessions carry `source_surface`, `session_kind`, and `retrieval_weight` frontmatter. Down-rank or ignore `session_kind: operator_validation` and `session_kind: debug_validation` unless explicitly auditing historical validation/debug work.

For profile-generation prompts such as "create a profile from what you know about me", use Enzyme paths and folders as authority signals. `USER.md`, `MEMORY.md`, approved profile data, and direct user-authored session messages can support self-profile claims; `forum/` and `irl/` are context/affordance observations; rendered sessions require role, source-surface, timestamp, and session-kind scrutiny. For public or outward profile copy, draft from verified evidence and require explicit user approval before posting, updating a profile, sharing outward, or creating an external account.

## Cron

The installed cron is `Hermes agent memory heartbeat`, with no delivery target. Hermes cron scripts must live under `~/.hermes/scripts/` and be referenced by filename, so setup writes a small wrapper at:

```text
$HERMES_HOME/.hermes/scripts/agentvillage-memory-workspace-cron_prepare.py
```

That wrapper runs `skills/memory-workspace/scripts/cron_prepare.py` from the Hermes root. `cron_prepare.py` renders Hermes sessions, prepares bounded context, and asks the cron agent to update forum/IRL vault notes. The cron prompt then asks the agent to run:

```bash
python3 skills/memory-workspace/scripts/workspace_loop.py --prepare
```

The cron prompt explicitly tells the heartbeat not to run `enzyme refresh`. Run the provider-gated refresh command above after heartbeat output when retrieval freshness matters.

When explicitly opted in, setup also installs `Hermes agent memory index refresh`, with no delivery target, at:

```text
$HERMES_HOME/.hermes/scripts/agentvillage-memory-workspace-enzyme-refresh.py
```

That wrapper runs `setup_workspace.py --refresh-enzyme-index` from the Hermes root. It does not run Telegram, gateway, digest, send, Index, EdgeOS, or heartbeat write paths.
