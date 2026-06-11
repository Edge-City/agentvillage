---
name: skill-atlas
description: "Lets an attendee build skills for their own agent from their tacit expertise: a research-informed expert interview produces a Skill Atlas card, then generates the complete installable skill folder with the expert's human-in-the-loop gates preserved. Optionally, with consent, advertises the finished skill as a capability on their Edge Book agent. Use when an attendee wants to turn what they know into a skill for their agent, create a Skill Atlas card, contribute expertise to the village skill commons, or build a skill that keeps a human in the loop. Do NOT use for generic prompt writing, quick one-off advice, or editing an existing skill the attendee already has."
version: 1.0.0
author: Antony Evans
tags: [edge-esmeralda, skill-atlas, expertise, human-in-the-loop, edge-book]
required_environment_variables:
  - name: EDGE_BOOK_CLI
    required_for: optional — overrides how the Edge Book CLI is invoked (default `edge-book` on PATH)
  - name: EDGE_BOOK_HOME
    required_for: optional — selects the Edge Book agent directory (Edge Book default is ~/.openclaw/edge-book)
---

# Skill Atlas

Lets an attendee build skills for their own agent from their expertise. Three phases, all human-in-the-loop: research the domain, interview the expert, then (with approval) generate the complete installable skill folder. The generated skill is the product — it works on the attendee's agent immediately, with no network or backend involved.

A subsidiary feature: with explicit consent, the finished skill can also be advertised as a capability on the attendee's Edge Book agent so their friends can discover it. This is optional and deferred — if Edge Book is not installed (`npm i -g edge-book`, then `edge-book init`), the registration queues locally and completes automatically whenever it is.

## Output Contract

Produces:
1. `skill-card.yaml` — the public Skill Atlas directory card.
2. `expertise-map.md` — the private working artifact (cues, criteria, examples, limits, validation cases).
3. On explicit approval: a complete generated skill folder (`SKILL.md` + references + evals) per `references/skill-generation.md`.
4. On explicit consent: a capability record in the local registry, advertised on the user's Edge Book agent when available (a signed `capability_advertisement` post via `edge-book capability advertise`).

Does not produce:
- A full skill folder without explicit approval.
- A capability advertisement without explicit consent.
- Payment, marketplace, or reputation infrastructure.
- Claims that a single-expert skill is broadly validated before scenario or community testing.

## Workflow

### Step 0: Sync Pending Registrations

At the start of every run, flush any previously generated capabilities that are still waiting for Edge Book:

```
bun scripts/register_capability.ts sync
```

If the script reports newly advertised capabilities, tell the user. If it reports `pending` (Edge Book not installed or not initialized yet), continue silently.

### Step 1: Classify the Request

- Expert has tacit knowledge but no precise workflow: continue.
- User wants a Skill Atlas card or community skill profile: continue.
- User already has a complete, precise SOP: skip the interview — go straight to Step 7 (generation) using their brief.
- User wants advice, not a reusable skill: answer normally; this skill does not apply.

### Step 2: Load Prior Context

Read `references/learnings.md` and summarize only the 3-5 relevant points. Then read `references/expert-elicitation.md` for the interview method and `assets/skill-atlas-card-template.yaml` for the output schema.

### Step 3: Run Domain Research Before the Interview

Research must happen before the human interview. Follow `references/domain-research.md`. The goal is to make the interview technically specific and give the expert concrete options to accept, reject, or adapt.

Present the synthesis before the interview:
- 3-5 nearby skill directions the expert could choose from.
- Technical terms and tools that may matter.
- 5-8 research-informed probes.
- Known failure modes and novice traps to validate.

### Step 4: Run the Expert Interview

Use `references/expert-elicitation.md`. Ask 3-5 questions at a time. Start with a real hard case, not an abstract process description.

Interview sequence:
1. Scope the repeatable task, target user, trigger, negative trigger, and desired output.
2. Build a 3-6 stage task diagram.
3. Walk through one difficult real incident.
4. Probe for cues, anomalies, discriminations, tradeoffs, and "what would change your mind."
5. Capture good, messy, edge, negative, and novice-trap examples.
6. Convert defensible judgment into if/then/because rules; convert fuzzy judgment into rubric dimensions; convert "the skill should not decide alone" into human review gates.
7. Ask the expert to define 3-5 validation scenarios.

### Step 5: Draft and Review the Skill Card

Create `skill-card.yaml` using `assets/skill-atlas-card-template.yaml`. Mark validation status honestly:
- `captured`: interview complete only.
- `expert-reviewed`: expert approved the card.
- `scenario-tested`: skill passed expert scenarios.
- `community-tested`: at least one other user used or reviewed it.

Validate the saved card:

```
bun scripts/validate_skill_card.ts path/to/skill-card.yaml
```

If Bun/Node is unavailable, manually check every required field against the template. Then ask the expert:

"What is wrong, overstated, missing, or too generic in this card?"

Revise once before continuing.

### Step 6: Build the Expertise Map

Create `expertise-map.md` using `assets/expertise-map-template.md`. Include the cognitive demands table from `assets/cognitive-demands-table.md` for the judgment-heavy step.

The expertise map is the private working artifact. The skill card is the public directory artifact.

### Step 7: Propose Skill Candidates and Get Approval

Present 3-5 possible skills generated from the expertise map. Each option must include: skill name, user trigger, output artifact, why it is useful to the community, validation scenarios available, and one risk or known limit.

Recommend one default. Ask the human to choose: stop at the Skill Atlas card, or proceed to full skill generation. Never generate without explicit approval.

### Step 8: Generate the Skill

On approval, follow `references/skill-generation.md` end to end. Key obligations:
- Treat the expert's scenarios as the eval seed set.
- Preserve every human review gate the expert defined — the generated skill must pause for the human at those points.
- Include `skill-card.yaml` inside the generated folder.
- Preserve validation status and known limits; do not harden fuzzy judgment into fake rules.
- Tell the user where to install the folder for their host (Claude Code, OpenClaw, or Hermes — install paths are in `references/skill-generation.md`).

### Step 9: Register the Capability

Follow `references/capability-registration.md`. In short:

1. Ask for consent: "Want me to advertise this skill as a capability on your Edge Book agent? It shares the skill's name, version, and a one-line summary — signed by your agent and visible to your Edge Book friends. Never the private expertise map." Proceed only on yes.
2. Run:

```
bun scripts/register_capability.ts register path/to/skill-card.yaml
```

3. The script writes the capability to the local registry. If Edge Book is installed and initialized, it runs `edge-book capability advertise` immediately — the capability becomes a signed advertisement on the user's agent. If not, the record stays `pending` and syncs automatically later — via Step 0 of any future run, or the `heartbeat.md` task on hosts with heartbeat ticks.

Tell the user which of the two outcomes happened. To withdraw a capability later: `edge-book capability deprecate <capability-id>` (the id is in the registry).

### Step 10: Closing Feedback Gate

Ask one question: "Did this capture your expertise accurately? Any corrections, exceptions, or examples I should learn from?"

Route feedback:
- Behavioral correction: append to `references/learnings.md`.
- Factual exception: append to `references/edge-cases.md`.
- "Never do X again": update `## Rules`.

## Gotchas

- **Symptom** — The generated card reads like a generic SOP anyone could write. **Cause** — The interview started with abstract process questions instead of a real difficult case. **Fix** — Re-run the critical incident section and probe cues, tradeoffs, and what novices missed.
- **Symptom** — The interview asks obvious or technically naive questions. **Cause** — The research-before-interview step was skipped or too shallow. **Fix** — Pause the interview, run the `references/domain-research.md` procedure, then return with 3-5 informed skill directions and specific probes.
- **Symptom** — The generated skill turns nuanced expert judgment into brittle thresholds. **Cause** — Fuzzy judgment was forced into fake rules. **Fix** — Move the judgment into rubric dimensions and examples unless the expert can defend the threshold with cases.
- **Symptom** — The card looks impressive but has no proof it works. **Cause** — Expert approval was treated as validation. **Fix** — Require 3-5 expert-authored scenarios before marking anything `scenario-tested`.
- **Symptom** — `register_capability.ts sync` keeps reporting pending forever. **Cause** — The Edge Book CLI is not installed, or `edge-book init` has not been run; the record is safely queued. **Fix** — Nothing to fix locally. Tell the user once that registration will complete after `npm i -g edge-book` and `edge-book init`; do not retry in a loop within one session.

## Rules

- Research must happen before the expert interview.
- Always present adjacent options from research so the expert can choose, reject, or combine approaches.
- Start the interview from a real hard case before asking for process.
- Capture examples and counterexamples as first-class assets, not optional notes.
- Never mark a single-expert card as community-tested.
- Never generate the full skill folder without explicit user approval.
- Never advertise a capability without explicit user consent, and never transmit the private expertise map — only the skill's name, version, and one-line summary are shared.
- Never invent profile data, handles, or URLs for the capability record; use values verbatim from the skill card the expert approved.
- Do not involve money, pricing, or marketplace mechanics unless the user explicitly requests it.
- Prefer honest validation status over polished claims.
