---
name: claude-optimizer
description: Audits and optimizes a Claude Code configuration (CLAUDE.md, rules/, references/, skills/) for context efficiency, using the three-layer progressive-disclosure model from Thariq's (@trq212) context engineering principles. Use this skill whenever the user asks to audit, clean up, shrink, or optimize their CLAUDE.md or Claude Code config; mentions dead references or broken links inside rules/references; asks whether their config follows context-engineering best practices; wants to find duplicated or contradictory instructions across CLAUDE.md and rules files; or asks to migrate outdated or retired Claude model IDs (e.g. claude-3-5-sonnet-20241022, claude-opus-4-6) to current ones. Also trigger on "context engineering", "system prompt bloat", "shrink my CLAUDE.md", or when the user references the "80% system prompt cut" the Anthropic team made to Claude Code.
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
- **Conditional-rule candidates**: rules whose content is dominated by one file-type keyword family (tests, lint, migrations, CSS, ...) and could gain a `paths:` frontmatter block.

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

The only two corrections this skill ever applies automatically, because both are purely mechanical (no content judgment involved):
1. Adding a `paths:` frontmatter block to a conditional-rule candidate found by the audit.
2. Replacing outdated/retired model IDs found inside the config itself.

Dead pointers, duplication, and contradiction candidates are never auto-fixed: deciding what a missing file should contain, which of two near-duplicate sentences to keep, or which side of a contradiction is correct requires a human. Run without `--apply` first, review the plan, then re-run with `--apply`. Every write is preceded by a backup under `_archive/apply-<timestamp>/`, and a `report.json` in that same folder records exactly what changed. Nothing is ever deleted.

### 4. Impact (`scripts/impact.mjs`)

Rate-limit impact estimation (how much the config diet actually buys inside the 5h session window and the weekly window), maintained separately. Not part of this skill's audit/migrate/apply flow.

## How to use this skill in a session

1. Run `audit.mjs` first, always. Show the user the report before touching anything.
2. If there are dead pointers, duplication, or contradiction candidates: discuss them with the user. These need a decision, not a script.
3. If there are conditional-rule candidates or outdated model IDs: run `apply.mjs` and `migrate-models.mjs` in dry-run, show the plan, get confirmation, then re-run with `--apply`.
4. Re-run `audit.mjs` after applying to confirm the always-loaded budget actually dropped, and report the real before/after numbers. Never state a byte or token figure that was not just measured on this machine.
5. If something looks wrong, the fix is in `_archive/`: the pre-change file is right there, restore it by hand.

## Safety model

- Every script is dry-run by default. Writing requires an explicit `--apply`.
- Nothing is ever deleted. The only filesystem writes are: rewriting a file in place (after backing it up) and creating files under `_archive/`.
- Scripts are plain Node (`.mjs`), zero external dependencies, no `npm install` needed. Node 18+ is enough (uses regex lookbehind and ES modules).
- `CLAUDE_CODE_CONFIG_DIR` is respected if set; otherwise the global config resolves to `~/.claude`. Pass `--dir` to point at a project's own config instead.

## Reference files (read on demand)

- `references/principles.md`: the seven context-engineering principles behind this skill, with the reasoning for each.
- `references/api-migration.md`: the Claude Opus 5 API breaking changes in detail (what changed, why, and the exact fix).
