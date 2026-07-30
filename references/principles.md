# The seven context-engineering principles

The reasoning behind this skill, drawn from the pattern Anthropic used when it cut Claude Code's own system prompt by more than 80% without losing eval quality. Read this file when you need to explain *why* a suggestion matters, not before every audit run, the SKILL.md summary is enough for that.

## 1. Aggressive removal

Instruction the model would already do on its own is pure cost: it competes for attention with everything else in context, and it does not change behavior. The test for any line in an always-loaded document is not "is this true" or "is this good advice", it is "would the model not already do this". If the answer is yes, cut it.

This is the single highest-leverage principle and the hardest to apply to your own writing, because every line felt necessary when it was added (usually right after an incident). A rule that fixed one bad outcome six months ago may no longer be pulling its weight if the model's baseline behavior has improved, or if the rule was really a one-off fix for a bug that got fixed elsewhere.

## 2. Do not over-constrain

A rule written as an absolute ("never do X") blocks judgment in the one case the author did not anticipate. An exception clause, or a principle plus the reasoning behind it, survives contact with a case the rule's author never considered; a flat prohibition does not. This does not mean absolutes are always wrong (some things genuinely must never happen, deleting production data without approval, for instance), it means every absolute should be a deliberate choice, not a reflex.

The contradiction-candidate detector in this skill exists because over-constraining tends to produce exactly this failure mode: an absolute rule written in one place collides with a narrower, more nuanced rule written somewhere else, and the two are never reconciled because nobody re-reads the whole config at once.

## 3. Rules become judgment

Enumerating twenty specific cases is a losing strategy: the twenty-first case is always the one that matters, and it is never covered. Stating the underlying principle, plus why it exists, lets the model generalize to cases the author never wrote down. "Never delete code without approval, except dead code and unused variables inside a section you're already editing" generalizes; a bullet list of every kind of code that is or is not exempt does not.

## 4. Examples become interface design

Five worked examples of "how to call this tool" is a symptom, not a fix: it means the tool's own interface is ambiguous enough to need examples in the first place. The fix is almost always at the interface level, rename a parameter, restructure the schema, make the correct usage the only usage that type-checks, not five more paragraphs of prose showing correct usage.

This is less directly automatable than the other six principles (the audit in this skill does not try to detect it), but it is worth keeping in mind when reviewing a rule that leans heavily on examples: the fix might not be a better rule, it might be a better tool.

## 5. Upfront becomes progressive disclosure

This is the mechanical core of what this skill measures and fixes. Three layers, three different costs:

| Layer | Cost | When it loads |
|---|---|---|
| CLAUDE.md | Always | Every single turn |
| `rules/*.md` without `paths:` | Always | Every single turn |
| `rules/*.md` with `paths:` | Conditional | Only when a file matching the globs is in play |
| `references/*.md` | On demand | Only when the agent deliberately reads it |

The `paths:` frontmatter mechanism is native to Claude Code, costs nothing to use, and most configs never use it because nobody has audited which rules qualify. A rule that is 100% about TypeScript linting, tagged with `paths: ["**/*.ts", "**/*.tsx"]`, costs zero bytes on a session that never touches a `.ts` file. The same rule left untagged costs its full byte count on every single turn, forever, regardless of relevance.

`audit.mjs` capability C3 finds candidates for this. `apply.mjs` can add the frontmatter mechanically once you have reviewed the suggestion.

## 6. Memory becomes auto-memory

A fact that changes (a harness version, a price, a model ID, an org's current headcount) does not belong hardcoded in a prompt. It belongs in a system the agent can query for the current value, or in an auto-updating memory file, not baked into text that will quietly go stale and nobody will notice until it causes a wrong answer.

`migrate-models.mjs` exists because this principle gets violated constantly with model IDs specifically: they get pasted into a config once, and eighteen months later half of them 404.

## 7. Specs become rich references

Detail that is needed occasionally, and in full, belongs in a file the agent reads on demand, not inline in an always-loaded document. This is the difference between layers 1-2 and layer 3 above. A 300-line reference on a specific migration's breaking changes costs nothing on every other kind of task; the same 300 lines pasted into CLAUDE.md costs it on every task, including the 99% that have nothing to do with that migration.

The test: if the answer to "does this apply to the current task" is usually no, it belongs in `references/`, not in CLAUDE.md or an unconditional rule.
