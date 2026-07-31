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
   **Or `@import` lines**: a config can build this same layer without a `rules/` directory at all, by writing `@context/git.md` inside CLAUDE.md. Claude Code inlines that file into every session, exactly like CLAUDE.md itself, resolving the path against the directory of the file that imports it and following up to four hops of nesting. Import costs the same as pasting the text in: it buys organization, never context. `paths:` frontmatter is a `rules/` feature and an imported file does not obey it, so the only way to take an imported file out of the always-loaded budget is to delete its `@import` line and cite it as an on-demand reference instead.

**Provenance decides, not the frontmatter.** Verified by controlled experiment on Claude Code v2.1.220 (2×2, run twice, identical results; positive control included; measured with file-reading tools disabled so only genuinely injected content could be reported):

| Where the file comes from | `paths:` present | Really costs |
|---|---|---|
| `rules/`, not imported | gate works | nothing, on unrelated sessions |
| `rules/`, also `@import`ed | ignored | the whole file, every session |
| `@import` from CLAUDE.md | ignored | the whole file, every session |

So a file carrying `paths:` that is pulled in by `@import` is a trap: its author believed they had made it cheap and conditional, and it is fixed weight instead. `audit.mjs` reports these in their own section. The fix is to move the file into `rules/` and delete the `@import` line. Never count such a file as conditional, and never report a saving for it.
3. **references/**: loaded only when the agent deliberately reads the file. Zero cost otherwise. Files that merely sit in `context/` and are never imported live here too: they cost nothing until something opens them.

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
node scripts/audit.mjs [--dir <config-dir>] [--json] [--lang <code>]
```

Read-only. The text report is translated (`--lang`, then `CLAUDE_OPTIMIZER_LANG`, then the audited `settings.json`, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English); `--json` stays in English. Reports:
- **Context budget**: bytes always loaded (CLAUDE.md + rules without `paths:` + every file pulled in by `@import`, transitively, `paths:` or not), bytes conditional (rules with `paths:` that are not also imported), bytes on demand (references/ plus the context cards nobody imports), skill and context-card counts.
- **Always-loaded documents, largest first**: every document behind that total with its bytes and share. Show the user this list, not just the total: it is the input to the distillation pass below, and a total on its own says a diet is needed without saying where to start.
- **Three-layer architecture**: whether the config actually has all three layers in place, counting an `@import` layer as a legitimate layer 2.
- **`paths:` being ignored**: files that declare `paths:` and are pulled in by `@import` anyway. Almost always an accident worth telling the user about, since they are paying for it on every session.
- **Dead pointers**: every `rules/*.md`, `references/*.md`, `hooks/*.js`, `skills/<name>`, `context/*`, `commands/*`, `agents/*` path cited in an always-loaded doc that does not resolve to a real file, plus every broken `@import`. This is the most common and most damaging config defect: telling the agent to open a file that is not there. A broken `@import` is the worst case of it, because the rule stops loading entirely and nothing warns anyone.
- **Duplication candidates**: near-identical sentences appearing in both CLAUDE.md and another always-loaded doc, rule or imported file (heuristic, similarity-scored).
- **Contradiction candidates**: pairs of lines across always-loaded docs using opposite polarity ("never" vs "always") on the same action verb (heuristic, always flagged for human review, never asserted as certain).
- **Conditional-rule candidates**: rules whose content is genuinely dominated by one file-type keyword family (tests, lint, migrations, CSS, ...) and could gain a `paths:` frontmatter block. Dominance is measured by density (share of the words), not raw hit count: a long rule about running a project mentions tests in passing without being a tests rule. Occurrences inside code spans, and whole lines carrying an example or negation marker (`exemplo`, `ex.:`, `anti-padrão`, `NUNCA`, `never`, `não faça`, `do not`, `❌`), are discarded before counting, because a keyword quoted as the mistake to avoid is not evidence of the file's topic.
- **Imported files that could leave the always-loaded budget**: the same detection applied to `@import` files, reported separately because the remedy is different. Never propose `paths:` for one of these: an imported file ignores it. The fix is to delete the `@import` line from CLAUDE.md and cite the file as an on-demand reference. `apply.mjs` refuses to write frontmatter into an imported file even with `--conditional-frontmatter`.

**Both candidate lists are proposals, not instructions, and you must treat them that way.** They print `CANDIDATE` and a caution for a reason: an early version told the user to delete the `@import` of `context/watchdog-nome-generico-cross-project.md`, a live safety rule that forbids killing processes by generic name, only because it quotes `` `coletor.py` `` and `` `main.py` `` as the anti-pattern it exists to prevent. Following that advice would have switched off a working protection while the byte count improved. **Open every candidate and read it before proposing anything to the user**, and say out loud when the heuristic looks wrong.

### 2. Migrate model IDs (`scripts/migrate-models.mjs`)

```
node scripts/migrate-models.mjs [--dir <path>]... [--apply] [--json] [--include-runtime] [--lang <code>]
```

Scans for retired (HTTP 404), deprecating, and outdated-but-active Claude model IDs, and proposes the current replacement. With no `--dir`, scans only the user's own config surface (CLAUDE.md, rules/, references/, commands/, agents/, hooks/, context/, settings.json), not the whole runtime data directory and not the bundled skills library (which legitimately documents old IDs as migration examples). Pass `--dir` (repeatable) to scan a project instead.

**`--dir` at a config directory does not mean the whole tree.** Runtime data there is skipped by default — `.claude.json`, `*-cache.json`, and `projects/`, `jobs/`, `session-env/`, `telemetry/`, `sessions/`, `shell-snapshots/`, `statsig/`, `file-history/`, `paste-cache/`, `cache/` — because a session transcript records which model actually ran a session that already happened, and rewriting it falsifies a record instead of migrating a setting. The report prints how many files it skipped, immediately above the invitation to run `--apply`. `--include-runtime` overrides it. An ordinary project directory is unaffected and is still scanned in full.

When a migration target is `claude-opus-5`, also prints a checklist of the known Opus 5 breaking changes to check by hand (`budget_tokens` removed, `temperature`/`top_p`/`top_k` rejected, assistant prefill rejected, thinking on by default and sharing the `max_tokens` budget, `disable_parallel_tool_use` for one-tool-per-turn loops). Full detail in `references/api-migration.md`.

With `--apply`, rewrites the model ID strings in place. Every changed file is copied to `_archive/model-migration-<timestamp>/` (relative to the scanned root) before being touched. Parameters like `temperature` or `budget_tokens` are flagged but never auto-edited: removing them changes behavior, that is a human call.

**A run that scanned zero files does not report a clean result.** If every file was skipped as runtime data, or the path holds nothing readable, the report says so and exits `2` instead of printing "no outdated or retired model IDs found" — that sentence over a scan that never happened is a clean bill of health nobody earned, and the file counter that contradicts it sits in the header where no one rereads it.

The text report is translated like the rest of the tool (`--lang`, then `CLAUDE_OPTIMIZER_LANG`, then the `language` field of the config being scanned, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English). This is the half of the tool that offers to write into someone's own configuration, so its risk warnings have to be readable by the person accepting the risk. `--json` stays in English on purpose: it is a machine interface, and wording that shifts per locale is not diffable.

### 3. Apply (`scripts/apply.mjs`)

```
node scripts/apply.mjs [--dir <config-dir>] [--apply] [--json]
```

By default this applies exactly one correction, because it is the only one that is purely mechanical and cannot change meaning: replacing outdated/retired model IDs found inside the config itself.

Adding a `paths:` frontmatter block is available behind `--conditional-frontmatter`, and it is deliberately opt-in. Marking a rule conditional declares it irrelevant to every session that does not touch those globs; if that judgment is wrong the rule silently stops loading while the byte count improves, which reads as a win and is a regression. Confirm with the user that the rule really is about that file type before applying it.

Dead pointers, duplication, and contradiction candidates are never auto-fixed: deciding what a missing file should contain, which of two near-duplicate sentences to keep, or which side of a contradiction is correct requires a human. Run without `--apply` first, review the plan, then re-run with `--apply`. Every write is preceded by a backup under `_archive/apply-<timestamp>/`, and a `report.json` in that same folder records exactly what changed. Nothing is ever deleted.

### 4. Impact (`scripts/impact.mjs`)

Rate-limit impact estimation (how much the config diet actually buys inside the 5h session window and the weekly window), maintained separately. Not part of this skill's audit/migrate/apply flow.

## The distillation pass (this is where the real work happens)

The scripts only handle what a script can decide safely. They will not shrink a config
that has no mechanical waste left, and on a mature config that is most configs.

**The large reduction comes from this section, and you are the one who performs it.** Do not
skip it, do not delegate it to `apply.mjs`, and do not tell the user the tool "already
optimized" their config when all that ran was the model-ID migration.

### When to do it

After `audit.mjs`, look at the "ALWAYS-LOADED DOCUMENTS, LARGEST FIRST" section it prints,
rules and `@import` files alike. Any of them over ~6 KB is a candidate. So is `CLAUDE.md`
itself if it is over ~15 KB.
For an imported file, step 5 below changes shape: the pointer replaces the `@import` line,
it does not sit next to it.

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

   **The dangerous variant.** When the rule ALREADY has a companion reference file, you are
   not moving a whole file, you are moving PIECES into a file that already exists. That is
   the normal case in a mature config and it is where facts evaporate: a piece that lands
   nowhere is a fact deleted, the byte count improves, and the report says the diet worked.
   The loss surfaces months later, when someone needs the org id and it is in no file at all.
   Never hand-check this. Step 5 does it mechanically.

5. **Prove nothing evaporated (MANDATORY, before you overwrite anything).**

   ```
   node scripts/verify-distillation.mjs --before <original> --after <distilled> \
        --into <reference-file> [--into <index>]...
   ```

   It extracts the atoms a human cannot re-derive from memory (identifiers, paths, commands,
   emails, URLs, flags) and reports every one present in the original and in none of the
   files after. Exit 2 means at least one orphan, so it can gate a hook or a test. Prose is
   out of scope on purpose: rewording is the whole point of distilling, and flagging it would
   bury the real losses.

   Run it BEFORE overwriting, against a copy. Every orphan gets moved somewhere or is
   declared disposable out loud, one by one. Then re-run until it exits 0.

   **Do not substitute your own reading for this.** On the run that produced this step, a
   careful manual check found 5 orphans and felt thorough; the script found 23 on the same
   pair, and 3 real facts had already been lost by the time it was written: the name of a
   Supabase org, the path of a hook (the bare filename survived, the path did not), and the
   exact `gh` command to switch accounts, which the distilled rule referred to without ever
   giving. Each was a sentence the author was sure carried the fact, and did not.

6. **Leave a pointer, and make it work.** The distilled rule opens with a line naming the
   reference file and when to open it. Use the full path from the config root. A pointer to
   a file that does not exist is worse than no pointer, and `audit.mjs` will catch it, so
   re-run the audit after.
7. **Add the reference to the index, and name what moved there.** `CLAUDE.md` gets a short
   table: file name, and the situation that should make you open it. If the destination
   gained a new KIND of content (identifiers, discarded alternatives), say so in the trigger
   line. Progressive disclosure only works if the agent knows the layer exists, and a trigger
   that undersells what is inside sends you looking in the wrong file.
8. **Measure and report honestly.** Re-run `audit.mjs` and report the real before and after.
   If the drop is small, say so. If the index grew because you widened a trigger line, report
   that too, instead of quoting the number you predicted.

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
- **Suggesting `paths:` for an imported file.** It is a `rules/` mechanism, confirmed by the
  experiment above. Written into a file that CLAUDE.md pulls in with `@`, it changes nothing at
  all: the same bytes keep loading on every session while the report claims a saving. For an
  imported file the only real fix is removing the `@import` line.
- **Trusting a candidate list without opening the file.** The topic detector reads keywords; it
  cannot tell a rule that uses a topic from a rule that forbids it. Read the file, then decide.
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
- Runtime data (`.claude.json`, caches, session transcripts) is never a migration target inside a config directory unless `--include-runtime` is passed.
- `node tests/run.mjs` runs the regression suite: plain Node, self-building fixtures in a temp directory of its own, non-zero exit on any failure. Run it after changing anything in `scripts/`.

## Reference files (read on demand)

- `references/principles.md`: the seven context-engineering principles behind this skill, with the reasoning for each.
- `references/api-migration.md`: the Claude Opus 5 API breaking changes in detail (what changed, why, and the exact fix).
