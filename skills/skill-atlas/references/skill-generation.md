# Skill Generation Procedure

Generates a complete, installable skill folder from an approved expertise map and skill card. Run only after the user explicitly approves a candidate in Step 7 of SKILL.md.

## Contents

1. Design before building
2. Folder structure
3. SKILL.md rules
4. Human-in-the-loop design (mandatory)
5. References, scripts, assets, evals
6. Validation checklist
7. Install paths per host

## 1. Design Before Building

Most intake is already done — the expertise map holds the task, trigger, negative trigger, output contract, judgment-heavy step, examples, and validation scenarios. Before writing files, present a short design summary and get a nod:

- **Name** — lowercase, hyphens, ≤64 chars, matches the folder name. Prefer gerund form (`reviewing-contracts`) or a clear noun.
- **Description** — the highest-leverage element; spend real effort here. It is a routing signal for agents, not a label for humans. Must contain, in one single-line string: capabilities (the artifacts it produces), trigger scenarios (the outcome language a user or agent would actually use), and negative triggers (similar-looking cases that must NOT activate it). Never use YAML folded syntax (`description: >`); if the line wraps, the skill silently breaks on some hosts.
- **Output contract** — what it produces, what it does not produce, and who consumes the output next.
- **Process steps** — for each step: what the agent does and *why* (the reasoning principle, so it generalizes to unseen cases), which reference file it loads, whether a human is involved, and the artifact produced.
- **Gotchas inventory** — at least 2 predicted failure modes, each as Symptom / Cause / Fix.

## 2. Folder Structure

```
skill-name/
├── SKILL.md              # SOP only — includes ## Gotchas (mandatory)
├── skill-card.yaml       # the approved Skill Atlas card, included verbatim
├── references/           # domain knowledge, style guides, dense rules
│   ├── learnings.md      # starts empty — grows with use (mandatory)
│   └── edge-cases.md     # starts empty — factual exceptions (mandatory)
├── scripts/              # deterministic execute steps (optional)
├── assets/               # templates and output examples (optional)
└── evals/
    └── evals.json        # 3+ test cases seeded from the expert's scenarios
```

No README.md, CHANGELOG.md, or library code inside the folder.

## 3. SKILL.md Rules

- Frontmatter: `name`, single-line `description`, `version: 1.0.0`, `author` (the expert's name, with their permission), `tags`. If the skill needs credentials, declare them under `required_environment_variables` with a `required_for` note each.
- Under 500 lines hard limit; aim for under 150 in the body. SKILL.md is a routing layer — push all reference material into `references/`.
- Numbered steps, third-person imperative ("Extract the…"), one word per concept, forward slashes in all paths.
- Host-neutral language: never assume a specific host's subagents, slash commands, or UI. Where a host capability is optional (web search, heartbeat), say what to do when it is absent.
- Mandatory `## Gotchas` section (≥2 entries, Symptom/Cause/Fix) immediately above `## Rules`.
- `## Rules` section: include "reference files are required, not optional", the human review gates from §4, and an explicit approval gate before any irreversible action (send, publish, delete, pay).

## 4. Human-in-the-Loop Design (mandatory)

Every review gate the expert defined in the interview becomes a hard pause in the generated skill. For each gate:

- State exactly what the agent presents to the human (prefer 3-5 options over a single output — this is the single highest-impact design decision).
- State what counts as approval and what the agent does on rejection.
- The agent never proceeds past a gate on silence, timeout, or its own judgment.

Additionally, every judgment the expert classified as "the skill should not decide alone" must route to the human, and every fuzzy judgment becomes a rubric dimension with examples — never a fake threshold.

## 5. References, Scripts, Assets, Evals

- **References** — one level deep only. Files over 100 lines get a table of contents. Move the expertise map's cues, decision criteria, and rubric dimensions into a domain reference the skill reads at the judgment-heavy step.
- **Scripts** — any step that makes an HTTP call, transforms files in a repeatable format, loops over many items, validates against a schema, or produces exact-format output ships as a script, not prose. Prefer TypeScript run with `bun` (the village runtime default); small and single-purpose; explicit error messages that tell the agent what to try next.
- **Assets** — concrete templates of the output, not prose descriptions of it. Include the expert's good/messy/edge examples.
- **Evals** — `evals/evals.json` with at least 3 cases: the happy path, one edge case, and one negative trigger. Each case has a `query` and verifiable `expected_behavior` assertions. Seed directly from the expert's validation scenarios; the novice-trap scenario is mandatory.

## 6. Validation Checklist

Before declaring the skill ready, verify:

- [ ] Description is a single line and contains capabilities + triggers + negative triggers.
- [ ] `## Gotchas` present with ≥2 grounded entries.
- [ ] `references/learnings.md` and `references/edge-cases.md` exist.
- [ ] Every expert-defined human gate appears as an explicit pause.
- [ ] `evals/evals.json` has ≥3 cases including the novice trap.
- [ ] `skill-card.yaml` is inside the folder, status and known limits unchanged.
- [ ] No host-specific assumptions without a documented fallback.

Then suggest a fresh-session test: install the skill, run the expert's 3-5 validation scenarios in a new conversation, and bring failures back as learnings. Only after those scenarios pass may the card's status move to `scenario-tested`.

## 7. Install Paths Per Host

Tell the user where to put the generated folder:

| Host | Path |
| --- | --- |
| Claude Code | `~/.claude/skills/<skill-name>/` (personal) or `.claude/skills/<skill-name>/` (project) |
| OpenClaw | `~/.openclaw/workspace/skills/<skill-name>/` |
| Hermes | `~/.hermes/skills/<skill-name>/` |

After install, the skill activates by its description on the next session. Remind the user that a skill is a maintenance obligation: when their workflow changes significantly, rebuild rather than patch, and deletion is a valid outcome.
