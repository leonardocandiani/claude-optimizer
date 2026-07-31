# claude-optimizer

Audits and reversibly optimizes a Claude Code configuration (`CLAUDE.md`, `rules/`, `references/`, `skills/`) for context efficiency, and migrates outdated Claude model IDs to current ones.

## Why this exists

Claude Code's own system prompt was cut by more than 80% without losing eval quality. The lesson is not "write less", it is that instruction competes with everything else in the context window for the model's attention, and most CLAUDE.md files grow by addition and never by subtraction. A rule gets added after every incident, nothing ever gets removed, and after a year the always-loaded prompt is tens of thousands of bytes the model has to read on every single turn, whether or not any of it applies to what you are doing right now.

Claude Code already ships the fix for this: rules in `rules/` can carry a `paths:` frontmatter block, and Claude Code only loads that rule when a file matching those globs is actually in play. Most configs never use it, because nobody audits which rules qualify. This tool finds them.

It also fixes the single most common and most damaging config defect: a rule or CLAUDE.md section that tells the agent to go read `references/some-file.md` or invoke `skills/some-skill`, and that path does not exist. The agent burns a tool call finding out, or worse, silently gives up and the instruction is never followed.

And because Claude model IDs change (retirements, renamed aliases, new generations), it scans for outdated ones and proposes the current replacement, flagging the API-level breaking changes that come with an Opus 5 migration specifically.

## Install

No install step. Clone or download this repo, the scripts are self-contained Node with zero dependencies.

```sh
git clone <this-repo> claude-optimizer
cd claude-optimizer
node scripts/audit.mjs
```

To use it as a Claude Code skill (so Claude invokes it on its own when relevant), drop the whole directory into `~/.claude/skills/claude-optimizer/` or your project's `.claude/skills/claude-optimizer/`.

## Requirements

Node 18 or newer. Nothing else. No `npm install`, no external packages anywhere in `scripts/`.

## Usage

By default every script targets `$CLAUDE_CODE_CONFIG_DIR` if set, otherwise `~/.claude`. Pass `--dir <path>` to point at a project's own config instead.

### Audit

```sh
node scripts/audit.mjs
node scripts/audit.mjs --dir ./my-project/.claude
node scripts/audit.mjs --json > audit.json
node scripts/audit.mjs --lang pt                  # force a language
```

Read-only. Reports the context budget (always-loaded vs conditional vs on-demand bytes), **the always-loaded documents listed largest first**, whether the three-layer architecture is in place, dead pointers, duplication candidates, contradiction candidates, and conditional-rule candidates. See "What it measures" below for what each of these means and how it is computed.

The text report is translated (see "Language" below); `--json` is the machine surface and stays in English. The document list is the part you act on:

```
ALWAYS-LOADED DOCUMENTS, LARGEST FIRST
  23 document(s), 99754 bytes in total. Any diet starts at the top of this list:
      bytes   share  document
      11476   11.5%  @context/pessoal-vs-profissional.md
       9280    9.3%  @context/trabalho.md
       8740    8.8%  CLAUDE.md
```

A total on its own only tells you a diet is needed. The list tells you where to start, and it is what the distillation pass below asks you to read.

### Migrate model IDs

```sh
node scripts/migrate-models.mjs                       # dry-run, scans your config
node scripts/migrate-models.mjs --dir ./src            # dry-run, scans a project
node scripts/migrate-models.mjs --dir ./src --apply    # writes replacements, backs up first
node scripts/migrate-models.mjs --dir ~/.claude --include-runtime   # rarely what you want
node scripts/migrate-models.mjs --lang pt                           # report in Portuguese
```

Finds retired (HTTP 404), deprecating, and outdated-but-still-active Claude model ID strings and proposes the current one. When a match resolves to `claude-opus-5`, it also prints a checklist of the API-level breaking changes worth checking by hand (see `references/api-migration.md`). `--apply` rewrites the strings in place; every changed file is backed up under `_archive/model-migration-<timestamp>/` first.

**Runtime data is not configuration.** When the scanned path sits inside a Claude Code config directory, these are skipped by default: `.claude.json`, cache files (`*-cache.json`), and the `projects/`, `jobs/`, `session-env/`, `telemetry/`, `sessions/`, `shell-snapshots/`, `statsig/`, `file-history/`, `paste-cache/` and `cache/` directories. A session transcript records which model actually ran a session that already happened; rewriting it does not migrate anything, it edits a historical record. The report says how many files were skipped, and says it again immediately above the invitation to run `--apply`. `--include-runtime` scans them anyway. Pointing `--dir` at an ordinary project is unaffected: the full tree is scanned, including folders that happen to be called `projects/` or `cache/`.

**A scan that read nothing says so.** If the skip above ate every file, or the path holds nothing readable, the report does not fall through to "no outdated or retired model IDs found" — it names the reason, points at the way out, and exits `2`. An empty result and a scan that never happened look identical from the outside, and only one of them is good news.

The report is translated (`--lang`, `CLAUDE_OPTIMIZER_LANG`, the `language` field of the config being scanned, `LC_ALL`/`LC_MESSAGES`/`LANG`, then English), including the severity tags and the API breaking-change hints. Someone being asked to authorise a write into their own configuration should be able to read the warning first. `--json` stays in English: machine interface.

### Apply the safe fixes

```sh
node scripts/apply.mjs                                   # dry-run: shows the plan
node scripts/apply.mjs --apply                           # writes it, backs up first
node scripts/apply.mjs --conditional-frontmatter --apply # also adds paths: to flagged rules
```

By default it applies exactly one kind of correction: replacing outdated model IDs found inside the config itself. That one is purely mechanical and cannot change meaning.

Adding `paths:` frontmatter is available but **opt-in**, via `--conditional-frontmatter`, because it is a judgment about meaning rather than a mechanical edit (see "Why `paths:` is opt-in" below). Dead pointers, duplication, and contradictions are reported but never auto-fixed, deciding what belongs there is a human call.

### Prove the distillation lost nothing

```sh
node scripts/verify-distillation.mjs --before rules/big.md --after rules/big.distilled.md \
     --into references/big-complete.md
```

Read-only. Run it **before** overwriting anything, against a copy.

Moving a whole rule into `references/` is trivially safe. The dangerous case is the one a mature config actually hits: the rule already has a companion reference file, so distilling means moving *pieces* into a file that already exists, and a piece that lands nowhere is a fact deleted. It fails silently and in the flattering direction, because the byte count improves and the report says the diet worked.

This extracts the atoms nobody can re-derive from memory (identifiers, paths, commands, emails, URLs, flags) and lists every one present in the original and in none of the files after. Prose is out of scope on purpose: rewording is the whole point of distilling. Exit 2 on any orphan, so it can gate a hook or a test.

Do not substitute your own reading for it. On the run this was written for, a careful manual check found 5 orphans and felt thorough; the script found 23 on the same pair, and three real facts had already been lost, each in a sentence the author was sure carried it.

### See what the diet actually bought you

```sh
node scripts/impact.mjs                       # compares against the newest backup found
node scripts/impact.mjs --before-bytes 84624  # or against an explicit "before" size
node scripts/impact.mjs --days 14             # widen the measurement window
```

Read-only. This is the part most people actually want, and it answers the question in the
only currency that matters if you are on a subscription: **not dollars, but how much more
work fits before you hit a usage limit.**

It reads your real transcripts, sums the actual input tokens per request (fresh input,
cache writes and cache reads all count against the limit), finds the heaviest rolling
5 hour window that genuinely happened, and works out how many more requests fit once the
always-loaded prompt shrinks. Then it converts that into working time, measured against
your real hours at the keyboard rather than calendar hours:

```
TIME BOUGHT BACK
────────────────────────────────────────────────────────────────────
  You worked 35.1h across 31 sessions in 7 days  (5.0h/day, ~1.1h per session)

  per week          +1.1h   about 1 extra session
  per month         +4.8h
  per year         +57.4h   7.2 working days of 8h
```

It is also built to talk you out of over-crediting the config diet. It shows you what
share of a request the config was in the first place, and what a far more aggressive cut
would and would not buy:

```
BUT LOOK WHERE YOUR TOKENS REALLY GO
────────────────────────────────────────────────────────────────────
  config (before)   ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  9.77%
  config (after)    ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  6.65%
  conversation      ███████████████████████████████░  90.23%
```

On most real configs the honest answer is that the prompt was never the expensive part,
and the tool says so out loud instead of inflating its own result.

Working hours are derived by grouping requests less than 15 minutes apart into continuous
blocks, which separates real work from idle time. Tokens are converted from bytes at a
ratio measured against the real API tokenizer (about 3.1 bytes per token for English and
Portuguese markdown); override it with `--ratio` if your config is mostly code or CJK.

## Language

The reports speak the user's language. `audit.mjs` and `impact.mjs` both go through `locales/`, detected automatically in this order:

1. `--lang <code>` on the command line
2. `CLAUDE_OPTIMIZER_LANG` in the environment
3. the `language` field in the user's Claude Code `settings.json`
4. `LC_ALL`, `LC_MESSAGES` or `LANG`
5. English

In `impact.mjs`, numbers follow the same locale, which matters more than it sounds:
`8.432.263.481` and `8,432,263,481` are the same number to a machine and two very
different numbers to a person reading quickly. `audit.mjs` deliberately does the opposite
and prints raw digits in every language: an audit figure gets pasted into issues, diffs and
commit messages, where an unambiguous `99754` beats a locale-correct `99.754`.

`--json` output is never translated, in either script. It is the machine surface.

Shipping today: English (`en`), Portuguese (`pt`), Spanish (`es`).

Adding one is a single file and needs no code change. Copy `locales/en.json` to
`locales/<code>.json`, translate the values, leave the `{placeholders}` alone. Missing keys
fall back to English rather than showing a raw key, so a partial translation is safe to
ship and safe to merge.

## What it measures

### Context budget

- **Always loaded**: `CLAUDE.md` bytes, plus every file in `rules/` that does not have a `paths:` key in its YAML frontmatter, plus every file `CLAUDE.md` pulls in with an `@import` line (transitively, up to four hops), **whether or not that imported file declares `paths:` of its own**. This is what Claude reads on every single turn. Configs that use `@import` instead of a `rules/` directory are common, and counting only CLAUDE.md for one of those reports a fraction of the real weight.
- **Always-loaded documents, largest first**: the breakdown behind that total, with each document's bytes and share. This is the list to work through when distilling.
- **Conditional**: every `rules/*.md` file that has a `paths:` key **and is not also imported**. Loaded only when a file matching one of those globs is part of the current work.
- **`paths:` that is being ignored**: a file that declares `paths:` and arrives through an `@import` anyway. The declaration does nothing there and the file loads in full on every session, which is almost always the opposite of what its author intended, so it gets its own warning with the fix (move it into `rules/`, delete the `@import` line).
- **On demand**: every file in `references/`, plus the files in `context/` that nothing imports. Loaded only when the agent chooses to read them.
- Skill count (directories under `skills/`, symlinks included) and context-card count (files under `context/`, if present) are reported for completeness. Context cards are only outside the always-loaded total when `CLAUDE.md` does not import them: an imported card is always loaded and is counted in the always-loaded line, not here.
- **Broken imports**: an `@import` pointing at a file that does not exist, or at an extension Claude Code will not inline, loads nothing and says nothing. Those are reported with the dead pointers, since the rule silently stops existing while the user still believes it is in force.

### Dead pointers

Every path matching `rules/...`, `references/...`, `hooks/...`, `skills/...`, `context/...`, `commands/...` or `agents/...` cited inside `CLAUDE.md`, a rule file or an imported file is resolved against the filesystem. A miss is reported with the file that cited it and the path it expected. This pattern match is intentionally narrow (only these prefixes, and always with at least one path segment after the slash) to avoid false positives on ordinary prose; a bare filename mentioned without one of those prefixes is out of scope. Broken `@import` lines are reported in the same section and marked as such.

### Duplication and contradiction candidates

Both are heuristics over the always-loaded documents (`CLAUDE.md`, rules without `paths:`, and the files imported with `@`), and both are reported as candidates for human review, never as certainties:

- **Duplication**: sentences from `CLAUDE.md` and an always-loaded rule or imported file are compared with a word-overlap (Jaccard) score; pairs above a similarity threshold are flagged.
- **Contradiction**: lines are scanned for a fixed list of action-verb stems (delete, commit, push, ask, edit, overwrite, skip) combined with "never"/"nunca" or "always"/"sempre". A "never delete X" in one file and an "always delete X" (or similar) in another, with enough word overlap, is flagged. This is a small, fixed pattern list, not exhaustive, and it is explicitly not proof of an actual contradiction, someone still has to read both lines.

### Conditional-rule candidates

A rule qualifies when its content is dominated by exactly one file-type keyword family (tests, lint, migrations, CSS, TypeScript, Python, SQL, Docker) with enough hits to be a real signal, and it does not already have a `paths:` block. The suggested globs are a starting point, not a final answer, review them before applying.

Counting is deliberately conservative, because a keyword only means "this file is about X" when X is being *used*, not when it is being *quoted as the thing to avoid*. Two kinds of occurrence are discarded before counting:

- anything inside code (fenced blocks, indented blocks, inline `` `spans` ``), which is where anti-pattern samples are almost always written;
- whole lines carrying an example or negation marker (`exemplo`, `ex.:`, `anti-padrão`, `NUNCA`, `never`, `não faça`, `do not`, `don't`, `❌`).

This came from a real false positive. A live safety rule forbidding "kill a process by generic name on a machine running several projects" was flagged as *"Python content, 13 keyword hits"* and proposed for unloading, purely because it spells the anti-pattern out as `` `coletor.py` `` and `` `main.py` ``. Both filters only ever remove hits, so the error can only fall on the safe side: the tool suggests less than it could, never more.

For the same reason, both candidate sections state a **candidate** and print a caution, rather than issuing an instruction. A heuristic that tells you to delete something is one bad classification away from doing damage.

### Why `paths:` never saves an imported file

This is the one place where getting the model wrong produces a number that is not just
imprecise but backwards, so it was settled by experiment rather than by reading.

**Verdict: `paths:` works in `rules/` and is ignored on a file that arrives through
`@import`.** A 2×2 controlled test on Claude Code v2.1.220, run twice with identical
results: four fixture files, each carrying a unique invented token, two reached by
`@import` and two living in `.claude/rules/`, one of each pair declaring a `paths:` glob
matching nothing. The session was then asked which tokens were present, with
`Read`, `Bash`, `Glob`, `Grep`, `Task`, `WebFetch`, `Edit` and `Write` disabled, so a token
could only be named if it had genuinely been injected into the context rather than read
off disk. The `rules/` file with the non-matching `paths:` did **not** appear, which is the
positive control proving the gate works and works only there. The imported file with the
very same frontmatter **did**.

So provenance decides, never the frontmatter:

| Where the file comes from | `paths:` in its frontmatter | Counted as |
|---|---|---|
| `rules/`, not imported | matches nothing right now | **Conditional** — genuinely off |
| `rules/`, also `@import`ed | ignored | **Always loaded**, in full |
| `@import` from `CLAUDE.md` | ignored | **Always loaded**, in full |

Earlier versions zeroed the cost of an imported file that declared `paths:`. That is
under-reporting dressed as a saving: the byte count improves, the context is spent anyway,
and nothing anywhere says so. One residual is left in on purpose: the frontmatter block is
stripped before injection, so counting the whole file overestimates by a few dozen tokens.
That error falls on the safe side, and removing it is not worth the risk of reintroducing
the under-reporting.

### Model ID migration

Model ID tables (retired, deprecating, outdated, current) are the published Anthropic migration data, not invented. Matching is word-boundary-safe so a shorter ID is never mistakenly matched inside a longer one. The default scan surface, when no `--dir` is given, is deliberately narrow: it covers `CLAUDE.md`, `rules/`, `references/`, `commands/`, `agents/`, `hooks/`, `context/`, `output-styles/`, `settings.json`, and `settings.local.json`, not the entire `~/.claude` runtime directory (which can hold tens of thousands of session and cache files) and not the bundled `skills/` library (skills often ship migration-guide documentation that intentionally mentions retired IDs as examples). Pass `--dir` explicitly to scan any other path in full, including a specific skill you wrote yourself.

Passing `--dir` at a config directory is the one case where "in full" would be wrong, and it is handled: runtime data is skipped there by default and the count of skipped files is reported (see "Migrate model IDs" above).

## Safety model

Every script defaults to dry-run: it reports what it found or what it would do, and writes nothing. Writing anything requires the explicit `--apply` flag. When a script does write:

- Every file it is about to change is copied to `_archive/` first, with a timestamped subfolder and the original relative path preserved.
- Nothing is ever deleted.
- `apply.mjs` additionally writes a `report.json` inside its backup folder recording exactly what changed and why.

If a change turns out wrong, the previous version of the file is sitting in `_archive/`, restore it by hand.

## Tests

```sh
node tests/run.mjs
```

Plain Node, no dependencies, no install step, same as the scripts. Every test builds its own fixtures at run time in its own temporary directory and removes only what it created, so the suite never reads or writes a real Claude Code config. It prints how many checks passed and failed per file plus a final summary, and exits non-zero if anything failed.

What is covered, and why each one is there:

| File | Guards against |
|---|---|
| `imports.test.mjs` | prose mentioning `@import` becoming a phantom import; import cycles looping; a broken import leaking into the dead-pointer list; an imported `paths:` file being counted as free; measurement depending on the order of the `@` lines |
| `legacy-format.test.mjs` | a classic `rules/` + `references/` config measuring differently than it always did, with every expected byte derived from the fixture the test just wrote |
| `topic-detector.test.mjs` | the false positive that proposed unloading a safety rule, and its opposite, a detector so timid it finds nothing |
| `apply-safety.test.mjs` | `apply.mjs` writing `paths:` into an imported file, plus the positive control that it still corrects a non-imported one |
| `migrate-runtime.test.mjs` | session transcripts and `.claude.json` being treated as configuration, and the reverse, an ordinary project being partially skipped |
| `i18n.test.mjs` | a translation key with no entry (the report would print the raw key), a locale silently losing keys, and a placeholder mangled in translation |

## The core of it: the distillation pass

Used as a Claude Code skill, the biggest part of this tool is not a script, it is the
procedure in `SKILL.md` that Claude follows with your judgment in the loop. The scripts
measure and catch mechanical defects; the distillation pass is what actually shrinks a
mature config, because deciding what an instruction really needs to say is not something
a regex can do safely.

The procedure turns one question on every long rule:

> Does the model need this **in every session**, or only **when the situation comes up**?

Almost every long rule is a mix of three things that belong in three different places: the
principle and its reason (stays), the catalogue of cases, examples and quotes (moves to
`references/`), and restatements of what the model already does right (deleted). That split
is principles 1, 5 and 7 of the article applied concretely, and it is where a 30 KB rule
becomes a 6 KB rule without losing anything the user taught.

`SKILL.md` also carries the guardrails, which matter as much as the method: never cut the
rule that exists because of an expensive repeated mistake, never cut a preference you cannot
re-derive (tone, naming, which email commits), never cut a rule you cannot explain, never
compress into vagueness, and never mark a rule conditional just because it mentions a topic.

## What you should realistically expect

Be suspicious of any config optimizer that promises a big automatic win, including this one.
The honest breakdown of where a large reduction actually comes from:

| Change | Who can do it | Typical size |
|---|---|---|
| Distilling a long rule into its essentials and moving the full text to `references/` | A human, or Claude with your judgment in the loop | Large. This is where the bytes are. |
| Removing a rule the model no longer needs told | A human | Medium |
| Adding `paths:` to a genuinely single-topic rule | This tool suggests, you approve | Small to medium |
| Fixing dead pointers | This tool finds, you fix | Zero bytes, real correctness win |
| Migrating outdated model IDs | This tool, automatically | Zero bytes, prevents 404s |

The reference numbers in this README came from a config that went from 84,624 to 57,589
bytes. **Most of that was distillation, a judgment call about what each rule really needed
to say, not something any script decided.** Two rules holding 41 KB of catalogued detail
became 11.7 KB of principles, with the full catalogue moved to `references/` and a pointer
left behind.

So if you run this and the byte count barely moves, the tool is not broken. It means your
config has no mechanical waste left, and what remains needs a human to read it and decide
what it is really for. Run `audit.mjs`, read the duplication and dead-pointer findings, and
do the distilling with Claude in the loop. That part cannot be safely automated, and this
tool deliberately does not pretend otherwise.

### Why `paths:` is opt-in

`apply.mjs` will not add `paths:` frontmatter unless you pass `--conditional-frontmatter`.
Marking a rule conditional declares it irrelevant to every session that does not touch
those globs. Get it wrong and the rule silently stops loading while the byte count drops,
which looks like a win and is a regression. An early version of this tool flagged a 30 KB
rule about running a project as "a tests rule" because it mentioned tests a dozen times in
passing; applying that would have switched off the user's most important instructions on
almost every session. The detector now requires topic density rather than raw hit counts,
and the apply step still asks first.

## What this does not do

- It does not estimate dollar savings or rate-limit impact. That is a separate tool (`scripts/impact.mjs` in this repo, or your own measurement against the real Anthropic `count_tokens` endpoint). This project deliberately does not invent conversion numbers.
- It does not auto-fix dead pointers, duplication, or contradictions. Those require a human decision about what the content should actually say.
- Duplication and contradiction detection are heuristics over English- and Portuguese-language patterns. They will miss things and will occasionally flag something that is not actually a problem, review before acting on them.

## License

MIT, see `LICENSE`.
