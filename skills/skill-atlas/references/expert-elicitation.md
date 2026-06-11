# Expert Elicitation Method

Use this reference during the expert interview. The goal is to extract tacit judgment, not to document an obvious SOP.

## Principles

- Research first. The interviewer should know the domain language, nearby methods, and likely failure modes before asking the expert questions.
- Incident first. A real difficult case reveals cues and tradeoffs that abstract questions hide.
- Cues before rules. Experts often know what matters before they can explain the rule.
- Examples are assets. Good, bad, messy, edge, and negative examples become skill assets and evals.
- Validation requires scenarios. "Looks good" is weak evidence.

## 50-Minute Interview Flow

### 1. Frame and Scope

Ask:
- What repeatable task do you do better than a competent novice?
- Who would use this skill?
- What input would they give it?
- What should the skill produce?
- What should this skill refuse or hand off?

Output: target user, task, trigger, negative trigger, output contract.

### 2. Task Diagram

Ask the expert to break the work into 3-6 stages.

For each stage ask:
- What is happening here?
- What makes this stage hard?
- Which stage requires the most judgment?
- Where do novices most often go wrong?

Output: task stages and judgment-heavy step.

### 3. Critical Incident

Ask for one difficult recent case. Walk through it from start to finish.

Probe:
- What was the first cue that this was not routine?
- What information did you seek?
- What information did you ignore?
- What tradeoff mattered most?
- What options did you consider?
- What would have changed your mind?
- What did someone less experienced miss?
- How did you know the final answer was good enough?

Output: cues, discriminations, decision points, uncertainty, recovery moves.

### 4. Knowledge Audit

Probe categories:
- Anomaly detection: what looks off before it is obvious?
- Typicality: how do you know whether this is a normal case?
- Big picture: what larger context changes the answer?
- Tricks of the trade: what shortcut or heuristic do you use?
- Mental simulation: what future consequence do you imagine?
- Recovery: what do you do when the first approach fails?
- Novice trap: what plausible answer is wrong?
- Stop condition: when should the agent ask a human?

Output: cognitive demands and novice traps.

### 5. Examples and Counterexamples

Capture:
- Good input with good output.
- Messy real-world input.
- Edge case.
- Negative trigger.
- Bad output the skill must avoid.
- Novice-trap case.

Output: assets and eval seed cases.

### 6. Decision Criteria

For each judgment, choose one:
- If/then/because rule: use only when the expert can defend the rule with examples.
- Rubric dimension: use for fuzzy judgment.
- Human review point: use when the skill should not decide alone.

Output: rules, rubric dimensions, human review gates.

### 7. Validation Plan

Ask:
- What 3-5 scenarios would prove this skill is useful?
- What must a good answer include?
- What would make you reject the skill?
- Which scenario is the novice trap?

Output: validation scenarios.

## Cognitive Demands Table

Use the template in `assets/cognitive-demands-table.md`.

Each row should capture:
- Task stage.
- Hard judgment.
- Cues.
- Expert strategy.
- Novice trap.
- Failure sign.
- Recovery move.
- Eval case.

## Research-Informed Option Crafting

Before the interview, the research synthesis should give the expert options such as:
- Alternative skill scopes.
- Adjacent methodologies.
- Tool or platform choices.
- Possible output formats.
- Validation methods.

Ask the expert to react:
- Which option is closest?
- Which is wrong for this domain?
- Which two should be combined?
- What is missing from all of them?

## Anti-Patterns

- Asking "describe your process" before a real case.
- Accepting generic answers without drilling into cues.
- Treating expert confidence as validation.
- Hiding uncertainty or known limits in the public card.
- Letting directory polish outrun actual skill quality.
