# Domain Research Procedure

Run this before every expert interview. The interviewer must know the domain language, nearby methods, and likely failure modes before asking the expert anything. This procedure is host-neutral: it uses whatever research tools the host provides and degrades gracefully when one is missing.

## Research Modes

Run every mode the host supports. Skip a mode silently if the host lacks the tool.

### Mode 1: Skill marketplace prior art

Search existing skill directories for skills that solve the same or an adjacent problem. Extract structural patterns, not content.

- `https://skills.sh/?q=[keyword]` — most curated; check install counts.
- `https://skillsmp.com/search?q=[keyword]` — largest raw index; favor higher-starred results.
- `https://github.com/anthropics/skills` — official reference patterns.

These directories have intermittent availability. If a fetch fails, skip the source and note it — do not retry more than once.

For each relevant hit (up to 3): note its process structure, human-in-the-loop design, output format, and guardrails. Do not copy skill content verbatim.

### Mode 2: Deep web research

Use the host's web search and fetch tools to find: best practices, established frameworks, standard terminology, common failure modes, and expert opinions in the domain. Favor practitioner sources over marketing content.

### Mode 3: Community knowledge

If the `geo-esmeralda` or `edgeos` skills are installed, query them for village-local context: attendees with related expertise, prior community content on the topic, and events where the skill could be tested. This grounds the skill in what the community actually needs.

### Mode 4: Local synthesis

Search the agent's local workspace and memory for prior notes on the topic. Synthesize across files: key themes, contradictions, gaps.

## Required Synthesis Output

Consolidate all modes into one synthesis with exactly these sections:

1. **Domain map** — the 5-10 concepts, tools, and methods that structure this domain.
2. **Adjacent skill options** — 3-5 distinct directions the expert's skill could take, each one sentence.
3. **Technical probes** — 5-8 specific, research-informed questions for the interview.
4. **Likely validation scenarios** — 2-3 candidate test cases the expert can refine.
5. **Known anti-patterns** — failure modes and novice traps documented in the domain.

## Quality Bar

- If the synthesis could have been written without doing the research, it is too shallow — redo Modes 1-2 with narrower queries.
- Distinguish high-confidence findings from inference. Flag gaps rather than filling them with speculation.
- Ground claims in what sources actually say; cite specifics (numbers, named examples) where possible.
