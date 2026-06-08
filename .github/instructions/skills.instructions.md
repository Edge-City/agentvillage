---
applyTo: "skills/**"
---

# Reviewing skill files

Files under `skills/**` are **agent instructions** — Markdown prose (and a few helper scripts) that an LLM agent reads at runtime to drive a flow. They are not application source code, and they are tuned by prompt engineering, not by tests or types. Review them as operational instructions for a model, not as code.

## Raise comments only for substantive issues

- **Correctness of the described flow** — wrong tool name or arguments, a step that contradicts an earlier step, a branch that can't be reached, or guidance that would make the agent call a tool at the wrong time (e.g. ignoring a stated turn boundary or polling contract).
- **Safety and policy** — privacy/consent gating, anti-fabrication rules (never invent handles, URLs, names, or facts; use values verbatim from a verifiable source), and anything that could route a user's data or an introduction to the wrong person.
- **Cross-section consistency** — two parts of the same file (or sibling skill files) that disagree on the same rule or example list.

## Do not raise

- Stylistic or wording preferences, tone, or "this could be phrased more precisely."
- Marginal edge cases that don't change the agent's actual behavior, or hypothetical placeholder/formatting concerns in example prose the agent composes naturally.
- Points already covered elsewhere in the same file, or ones a prior review round already resolved.
- Suggestions that simply add more words; prose precision is asymptotic, so prefer fewer, higher-signal comments over exhaustive rewordings.

If a change is correct, safe, and internally consistent, approve it. A clean review with no comments is the expected outcome for a sound skill edit.
