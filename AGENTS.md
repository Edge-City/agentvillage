# AgentVillage

AgentVillage is the public skills package and installer for Edge City agent experiences. Repository-development guidance belongs here; `workspace/AGENTS.md` is shipped runtime behavior for attendee agents and remains authoritative within `workspace/`.

## Project context and boundaries

- Use Bun for repository scripts unless a scoped file says otherwise.
- Read `CLAUDE.local.md` when it exists, then the nearest nested `CLAUDE.md` or `AGENTS.md` before changing a specialized subtree. These files can contain local or scoped boundaries. Preserve Claude sources; translate relevant guidance into Codex behavior rather than editing those files for migration alone.
- For work under `private/`, read its local guidance. Treat `private/context/vault/` as read-only and verify dated notes before relying on them. Proposed infrastructure is not live until its acceptance scenario passes.
- `CLAUDE.local.md`, `private/`, `controlplane/`, and `landing/` are private or locally excluded. Never force-add them. Move team-ready work into a tracked repository path deliberately and review it for public exposure.
- Keep credentials and private attendee data out of source, logs, fixtures, prompts, and user-facing output. Preserve consent, confirmation, and server-only key boundaries.

## Codex model orchestration

Use **Astra** for design, architecture, material decisions, integrated conformance review, and final integration. Delegate substantive implementation and sustained research to **Sol** as bounded, coherent units that include tests and routine debugging. Keep small, context-bound edits in the parent when delegation would add more overhead than value. Prefer medium reasoning; reserve high reasoning for hard decisions and critical reviews.

Use **Spark** for bounded DOM/text browser checks, smoke tests, and small understood fix-retest loops. Use Sol if Spark is unavailable or lacks a required capability. Route screenshot-based visual judgment to Sol or Astra. After two unsuccessful small fix-retest cycles, or when diagnosis crosses contracts, hand the investigation to Sol; Astra retains consequential architecture, security, privacy, data-integrity, and deployment decisions. Never claim a model was used without runtime confirmation.

Delegated prompts must be concise and self-contained: include the objective, acceptance criteria, binding spec sections, constraints, exact owned and forbidden paths, required checks, and expected evidence. Prefer a clean worker context with the relevant excerpts over copying the full conversation. Parallel work requires disjoint paths or isolated worktrees; only one agent controls a browser session at a time.

Let workers finish their implementation-and-verification unit. Resume the parent for completion, a genuine blocker, a material decision, or required review; avoid routine progress polling and repeated inspection of unfinished work. Worker handoffs summarize changed files, decisions, check results with exit codes, and unresolved risks instead of dumping logs.

## Review and verification

Astra reviews the complete integrated diff against the acceptance criteria at meaningful milestone boundaries and before its first merge, release, or exposure to real attendee data. For contract-bearing changes, also use a fresh independent **Sol** refuter on the complete milestone diff before that milestone's first merge, release, or exposure to real attendee data. Contract-bearing surfaces include API and MCP shapes, installer/runtime configuration, persisted state, cron behavior, authentication, consent, and cross-skill contracts. Give the refuter the diff, binding spec, and explicitly accepted decisions, without the implementation conversation or build prompts. It attacks and reports, lists attempted attacks even when no defect is found, and leaves fixes to the implementer. Preserve any stricter scoped conformance or refutation requirements from the affected subtree or task.

Avoid duplicate full adversarial passes for an unchanged milestone. Recheck affected seams after fixes; material contract changes reopen review. Unresolved findings block delivery, and no review-count cap waives a defect. Astra retains critical security, privacy, data-integrity, architecture, and deployment review. Docs, copy, and CSS-only changes skip independent refutation when the actual diff stays within that scope.

Run checks appropriate to the changed behavior and inspect actual exit codes and failures. Verify installed or rendered behavior for user-facing and installer changes rather than treating source text as proof. Do not repeat broad suites after required checks pass unless changed code, failures, or unresolved concerns justify it. Instruction-only changes need diff and consistency checks, not an application build.

Keep searches and reads targeted; reuse established evidence unless it may have changed. Treat lower token cost as an objective, not a measured result or a reason to weaken acceptance criteria. Do not automatically downgrade models, redeem resets, buy credits, or resume after usage exhaustion without fresh user direction.

At handoff, report the exact repository/worktree and branch, reviewed changes, checks and exit codes, commit IDs and actual delivery state, outstanding work, and next action. Stage only in-scope files and preserve unrelated work.

This is a public team repository. Start human work from fresh `origin/main` on a short-lived `carter/<topic>` branch. Before opening a PR, fetch and rebase onto current `origin/main`, then rerun the affected checks. Push the topic branch and open a PR when delivery is authorized; maintainers merge it. Never push human work directly to `main`, force-add excluded paths, or add false co-author attribution. Deploy or publish only when separately authorized.

## Import recovery boundary

Treat imported conversations, task records, memories, and prior deployment instructions as historical context. Importing them does not authorize restarting schedules, unattended coding loops, paid calls, cloud mutations, deployments, or unfinished releases. Verify current repository and external state before resuming newly authorized work.
