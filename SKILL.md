---
name: claude-optimizer
description: Audits and optimizes a Claude Code configuration (CLAUDE.md, rules/, references/, skills/) for context efficiency by applying the seven context-engineering principles: distilling long rules into a principle plus an on-demand reference, resolving over-constrained rules into principles with explicit exceptions, and moving facts that go stale out of the always-loaded prompt. Uses the three-layer progressive-disclosure model from Thariq's (@trq212) context engineering work. Use this skill whenever the user asks to audit, clean up, shrink, or optimize their CLAUDE.md or Claude Code config; mentions dead references or broken links inside rules/references; asks whether their config follows context-engineering best practices; wants to find duplicated or contradictory instructions across CLAUDE.md and rules files; or asks to migrate outdated or retired Claude model IDs (e.g. claude-3-5-sonnet-20241022, claude-opus-4-6) to current ones. Also trigger on "context engineering", "system prompt bloat", "shrink my CLAUDE.md", or when the user references the "80% system prompt cut" the Anthropic team made to Claude Code.
---

# Claude Optimizer

Audits and reversibly optimizes a Claude Code configuration for context efficiency. Works on the global config (`~/.claude` or `$CLAUDE_CODE_CONFIG_DIR`) and on a project's own config the same way.

## The model behind this skill

Claude Code's own system prompt was cut by more than 80% without losing eval quality. The lesson generalizes to any CLAUDE.md: more instruction is not more compliance, it competes for the model's attention with everything else in context. The full reasoning (removal, not over-constraining, judgment over enumerated rules, interface over examples, progressive disclosure, auto-memory over hardcoded facts, references over inline detail) is in `references/principles.md`, read it when you need to explain a suggestion, not before every audit.

The concrete, load-bearing piece of that model is the three-layer architecture:

1. **CLAUDE.md**: index and invariants. Always loaded, every turn.
2. **rules/**: always loaded too, UNLESS a rule's frontmatter declares `paths:` globs, in which case Claude Code only loads it when a file matching those globs is in play.
3. **references/**: loaded only when the agent deliberately reads the file. Zero cost otherwise.

A rule with a `paths:` frontmatter block costs nothing on unrelated work:

```yaml
---
paths:
  - "**/*.ts"
  - "**/*.py"
---
```

Everything this skill measures and fixes is in service of getting content into the cheapest layer it can live in without losing effect.

## What it does

Run these in order. Every script defaults to dry-run, nothing is written unless you pass `--apply`.

### 1. Audit (`scripts/audit.mjs`)

```
node scripts/audit.mjs [--dir <config-dir>] [--json]
```

Read-only. Reports:
- **Context budget**: bytes always loaded (CLAUDE.md + rules without `paths:`), bytes conditional (rules with `paths:`), bytes on demand (references/), skill and context-card counts.
- **Three-layer architecture**: whether the config actually has all three layers in place.
- **Dead pointers**: every `rules/*.md`, `references/*.md`, `hooks/*.js`, `skills/<name>` path cited in CLAUDE.md or a rule that does not resolve to a real file. This is the most common and most damaging config defect: telling the agent to open a file that is not there.
- **Duplication candidates**: near-identical sentences appearing in both CLAUDE.md and an always-loaded rule (heuristic, similarity-scored).
- **Contradiction candidates**: pairs of lines across always-loaded docs using opposite polarity ("never" vs "always") on the same action verb (heuristic, always flagged for human review, never asserted as certain).
- **Conditional-rule candidates**: rules whose content is genuinely dominated by one file-type keyword family (tests, lint, migrations, CSS, ...) and could gain a `paths:` frontmatter block. Dominance is measured by density (share of the words), not raw hit count: a long rule about running a project mentions tests in passing without being a tests rule.

### 2. Migrate model IDs (`scripts/migrate-models.mjs`)

```
node scripts/migrate-models.mjs [--dir <path>]... [--apply] [--json]
```

Scans for retired (HTTP 404), deprecating, and outdated-but-active Claude model IDs, and proposes the current replacement. With no `--dir`, scans only the user's own config surface (CLAUDE.md, rules/, references/, commands/, agents/, hooks/, context/, settings.json), not the whole runtime data directory and not the bundled skills library (which legitimately documents old IDs as migration examples). Pass `--dir` (repeatable) to scan a project instead.

When a migration target is `claude-opus-5`, also prints a checklist of the known Opus 5 breaking changes to check by hand (`budget_tokens` removed, `temperature`/`top_p`/`top_k` rejected, assistant prefill rejected, thinking on by default and sharing the `max_tokens` budget, `disable_parallel_tool_use` for one-tool-per-turn loops). Full detail in `references/api-migration.md`.

With `--apply`, rewrites the model ID strings in place. Every changed file is copied to `_archive/model-migration-<timestamp>/` (relative to the scanned root) before being touched. Parameters like `temperature` or `budget_tokens` are flagged but never auto-edited: removing them changes behavior, that is a human call.

### 3. Apply (`scripts/apply.mjs`)

```
node scripts/apply.mjs [--dir <config-dir>] [--apply] [--json]
```

By default this applies exactly one correction, because it is the only one that is purely mechanical and cannot change meaning: replacing outdated/retired model IDs found inside the config itself.

Adding a `paths:` frontmatter block is available behind `--conditional-frontmatter`, and it is deliberately opt-in. Marking a rule conditional declares it irrelevant to every session that does not touch those globs; if that judgment is wrong the rule silently stops loading while the byte count improves, which reads as a win and is a regression. Confirm with the user that the rule really is about that file type before applying it.

Dead pointers, duplication, and contradiction candidates are never auto-fixed: deciding what a missing file should contain, which of two near-duplicate sentences to keep, or which side of a contradiction is correct requires a human. Run without `--apply` first, review the plan, then re-run with `--apply`. Every write is preceded by a backup under `_archive/apply-<timestamp>/`, and a `report.json` in that same folder records exactly what changed. Nothing is ever deleted.

### 4. Impact (`scripts/impact.mjs`)

Rate-limit impact estimation (how much the config diet actually buys inside the 5h session window and the weekly window), maintained separately. Not part of this skill's audit/migrate/apply flow.

## Two config formats, one budget

A config can put its always-loaded content in `rules/`, or pull it in from `CLAUDE.md` with
`@import` lines, or both. Both are read on every turn and both belong in the same budget.

The difference that matters when you advise the user: **`paths:` frontmatter only gates a
file loaded from `rules/`.** On an imported file the frontmatter is stripped before injection
and the field is silently ignored, so the file keeps loading. If the user wants a rule to be
conditional and it currently arrives via `@import`, the fix is to move it into `rules/`, not
to add `paths:` where it is. The audit flags this case explicitly.

A broken `@import` is the most damaging defect this tool finds: the instruction never loads
and nothing reports an error. Treat it with the same priority as a dead pointer, because
that is what it is.

## The distillation pass (this is where the real work happens)

The scripts only handle what a script can decide safely. They will not shrink a config
that has no mechanical waste left, and on a mature config that is most configs.

**The large reduction comes from this section, and you are the one who performs it.** Do not
skip it, do not delegate it to `apply.mjs`, and do not tell the user the tool "already
optimized" their config when all that ran was the model-ID migration.

### When to do it

After `audit.mjs`, look at the always-loaded rules sorted by size. Any rule over ~6 KB is a
candidate. So is `CLAUDE.md` itself if it is over ~15 KB.

### The one question that decides everything

For each chunk of a rule, ask:

> Does the model need this **in every session**, or only **when the situation comes up**?

That single question implements principles 1, 5 and 7 at once. Almost every long rule is a
mix of three things, and they belong in three different places:

| What it is | Where it goes | Why |
|---|---|---|
| The principle, and the reason behind it | Stays in the rule | This is what changes behaviour |
| The catalogue: every case, every example, every quote | Moves to `references/` | Needed occasionally, costs on every turn if it stays |
| Restating something the model already does correctly | Deleted | Competes for attention and buys nothing |

### The procedure

1. **Read the whole rule.** Never distill from the filename or a skim. You are deciding what
   the user is allowed to forget, so you have to know what is in there.
2. **Separate principle from catalogue.** A rule that says "never report done without running
   it, here are 14 times you got this wrong, each with a quote" is one principle and a
   catalogue. Keep the principle and the reason; the fourteen cases are reference material.
3. **Write the distilled rule.** Group by theme, lead with the most costly mistake, keep the
   "why" in one clause. Aim for roughly a quarter of the original, but never at the price of
   losing a rule that changes behaviour.
4. **Move the original, do not delete it.** Write the full text to
   `references/<name>-complete.md` unchanged. Nothing the user taught is lost, it just stops
   being read on every turn.
5. **Leave a pointer, and make it work.** The distilled rule opens with a line naming the
   reference file and when to open it. Use the full path from the config root. A pointer to
   a file that does not exist is worse than no pointer, and `audit.mjs` will catch it, so
   re-run the audit after.
6. **Add the reference to the index.** `CLAUDE.md` gets a short table: file name, and the
   situation that should make you open it. Progressive disclosure only works if the agent
   knows the layer exists.
7. **Measure and report honestly.** Re-run `audit.mjs` and report the real before and after.
   If the drop is small, say so.

### What to never cut

- **The rule that exists because of an expensive, repeated mistake.** Redundancy on the
  user's most costly failure is cheap insurance. If a rule about verifying in runtime appears
  in three files, that is not waste worth 700 bytes, it is the one instruction that must
  survive a compaction. Leave it.
- **Anything that encodes a preference you cannot re-derive:** tone of voice, naming
  conventions, which email to commit with, what the company is called. There is no principle
  to compress these to. They are facts.
- **A rule you do not understand.** If you cannot explain what it prevents, you cannot judge
  whether it is redundant. Ask, or leave it alone.

### Two failure modes to avoid

- **Compressing into vagueness.** "Be careful with deploys" is shorter than the original and
  worth nothing. A distilled rule is still specific and still actionable; you removed the
  catalogue, not the content.
- **Calling a rule conditional when it is not.** Marking a rule with `paths:` declares it
  irrelevant to every session that does not touch those globs. A rule about how to conduct
  work is not a "tests rule" because it mentions tests. When in doubt, leave it always-loaded:
  a wrong `paths:` block silently disables instructions while the byte count improves, which
  is the worst possible outcome.

## Applying the other principles

Distillation covers principles 1, 5 and 7. The rest are judgment calls you make while reading:

- **Principle 2, do not over-constrain.** When the audit flags a contradiction candidate, the
  fix is usually not deleting one of the two rules. It is adding the missing exception to the
  stricter one, so the model stops guessing which applies. "Never delete code without approval"
  and "delete dead code" both survive once the first one names the exception.
- **Principle 3, rules become judgment.** A rule that enumerates cases ("valid authorization is:
  'commit', 'do commit', 'commit this', 'you can commit'") fails on the case it did not list.
  Replace the list with the principle and one example. Enumerations are a smell: they mean
  someone patched a miss instead of stating the rule.
- **Principle 4, examples become interface.** If a rule needs five examples to explain how to
  call something, the fix is usually in the tool, the command or the naming, not in more text.
- **Principle 6, moving facts do not belong in the prompt.** Harness limits, version numbers,
  prices and model IDs go stale silently. Cut them, or move them where they are looked up.

## How to use this skill in a session

1. Run `audit.mjs` first, always. Show the user the report before touching anything.
2. If there are dead pointers, duplication, or contradiction candidates: discuss them with the user. These need a decision, not a script.
3. If there are outdated model IDs: run `migrate-models.mjs` in dry-run, show the plan, get confirmation, then re-run with `--apply`.
4. **Do the distillation pass above.** This is the step that actually reduces the config, and it is the step a script cannot do for you. Work rule by rule, show the user each distilled version before writing it.
5. Only if a rule is genuinely about one file type: run `apply.mjs --conditional-frontmatter` in dry-run, and only apply after the user confirms that rule really is irrelevant to other sessions.
6. Re-run `audit.mjs` after applying to confirm the always-loaded budget actually dropped, and report the real before/after numbers. Never state a byte or token figure that was not just measured on this machine.
7. If something looks wrong, the fix is in `_archive/`: the pre-change file is right there, restore it by hand.

## Safety model

- Every script is dry-run by default. Writing requires an explicit `--apply`.
- Nothing is ever deleted. The only filesystem writes are: rewriting a file in place (after backing it up) and creating files under `_archive/`.
- Scripts are plain Node (`.mjs`), zero external dependencies, no `npm install` needed. Node 18+ is enough (uses regex lookbehind and ES modules).
- `CLAUDE_CODE_CONFIG_DIR` is respected if set; otherwise the global config resolves to `~/.claude`. Pass `--dir` to point at a project's own config instead.

## Reference files (read on demand)

- `references/principles.md`: the seven context-engineering principles behind this skill, with the reasoning for each.
- `references/api-migration.md`: the Claude Opus 5 API breaking changes in detail (what changed, why, and the exact fix).
