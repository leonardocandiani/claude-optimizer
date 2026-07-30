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
```

Read-only. Reports the context budget (always-loaded vs conditional vs on-demand bytes), whether the three-layer architecture is in place, dead pointers, duplication candidates, contradiction candidates, and conditional-rule candidates. See "What it measures" below for what each of these means and how it is computed.

### Migrate model IDs

```sh
node scripts/migrate-models.mjs                       # dry-run, scans your config
node scripts/migrate-models.mjs --dir ./src            # dry-run, scans a project
node scripts/migrate-models.mjs --dir ./src --apply    # writes replacements, backs up first
```

Finds retired (HTTP 404), deprecating, and outdated-but-still-active Claude model ID strings and proposes the current one. When a match resolves to `claude-opus-5`, it also prints a checklist of the API-level breaking changes worth checking by hand (see `references/api-migration.md`). `--apply` rewrites the strings in place; every changed file is backed up under `_archive/model-migration-<timestamp>/` first.

### Apply the safe fixes

```sh
node scripts/apply.mjs             # dry-run: shows the plan
node scripts/apply.mjs --apply     # writes it, backs up first, writes a report.json
```

Applies exactly two kinds of correction, both mechanical: adding `paths:` frontmatter to a rule the audit flagged as dedicated to one file type, and replacing outdated model IDs found inside the config itself. Dead pointers, duplication, and contradictions are reported but never auto-fixed, deciding what belongs there is a human call.

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

The report speaks the user's language, detected automatically in this order:

1. `--lang <code>` on the command line
2. `CLAUDE_OPTIMIZER_LANG` in the environment
3. the `language` field in the user's Claude Code `settings.json`
4. `LC_ALL`, `LC_MESSAGES` or `LANG`
5. English

Numbers follow the same locale, which matters more than it sounds: `8.432.263.481` and
`8,432,263,481` are the same number to a machine and two very different numbers to a
person reading quickly.

Shipping today: English (`en`), Portuguese (`pt`), Spanish (`es`).

Adding one is a single file and needs no code change. Copy `locales/en.json` to
`locales/<code>.json`, translate the values, leave the `{placeholders}` alone. Missing keys
fall back to English rather than showing a raw key, so a partial translation is safe to
ship and safe to merge.

## What it measures

### Context budget (capability A)

- **Always loaded**: `CLAUDE.md` bytes plus every file in `rules/` that does not have a `paths:` key in its YAML frontmatter. This is what Claude reads on every single turn.
- **Conditional**: every `rules/*.md` file that does have a `paths:` key. Loaded only when a file matching one of those globs is part of the current work.
- **On demand**: every file in `references/`. Loaded only when the agent chooses to read it.
- Skill count (directories under `skills/`, symlinks included) and context-card count (files under `context/`, if present) are reported for completeness, they are not part of the always-loaded byte total since Claude Code injects them conditionally too.

### Dead pointers (capability B)

Every path matching `rules/...`, `references/...`, `hooks/...`, or `skills/...` cited inside `CLAUDE.md` or a rule file is resolved against the filesystem. A miss is reported with the file that cited it and the path it expected. This pattern match is intentionally narrow (only these four prefixes) to avoid false positives on ordinary prose; a bare filename mentioned without one of those prefixes is out of scope.

### Duplication and contradiction candidates (capability C)

Both are heuristics over the always-loaded documents (`CLAUDE.md` plus rules without `paths:`), and both are reported as candidates for human review, never as certainties:

- **Duplication**: sentences from `CLAUDE.md` and a rule are compared with a word-overlap (Jaccard) score; pairs above a similarity threshold are flagged.
- **Contradiction**: lines are scanned for a fixed list of action-verb stems (delete, commit, push, ask, edit, overwrite, skip) combined with "never"/"nunca" or "always"/"sempre". A "never delete X" in one file and an "always delete X" (or similar) in another, with enough word overlap, is flagged. This is a small, fixed pattern list, not exhaustive, and it is explicitly not proof of an actual contradiction, someone still has to read both lines.

### Conditional-rule candidates (capability C)

A rule qualifies when its content is dominated by exactly one file-type keyword family (tests, lint, migrations, CSS, TypeScript, Python, SQL, Docker) with enough hits to be a real signal, and it does not already have a `paths:` block. The suggested globs are a starting point, not a final answer, review them before applying.

### Model ID migration (capability D)

Model ID tables (retired, deprecating, outdated, current) are the published Anthropic migration data, not invented. Matching is word-boundary-safe so a shorter ID is never mistakenly matched inside a longer one. The default scan surface, when no `--dir` is given, is deliberately narrow: it covers `CLAUDE.md`, `rules/`, `references/`, `commands/`, `agents/`, `hooks/`, `context/`, `output-styles/`, `settings.json`, and `settings.local.json`, not the entire `~/.claude` runtime directory (which can hold tens of thousands of session and cache files) and not the bundled `skills/` library (skills often ship migration-guide documentation that intentionally mentions retired IDs as examples). Pass `--dir` explicitly to scan any other path in full, including a specific skill you wrote yourself.

## Safety model

Every script defaults to dry-run: it reports what it found or what it would do, and writes nothing. Writing anything requires the explicit `--apply` flag. When a script does write:

- Every file it is about to change is copied to `_archive/` first, with a timestamped subfolder and the original relative path preserved.
- Nothing is ever deleted.
- `apply.mjs` additionally writes a `report.json` inside its backup folder recording exactly what changed and why.

If a change turns out wrong, the previous version of the file is sitting in `_archive/`, restore it by hand.

## What this does not do

- It does not estimate dollar savings or rate-limit impact. That is a separate tool (`scripts/impact.mjs` in this repo, or your own measurement against the real Anthropic `count_tokens` endpoint). This project deliberately does not invent conversion numbers.
- It does not auto-fix dead pointers, duplication, or contradictions. Those require a human decision about what the content should actually say.
- Duplication and contradiction detection are heuristics over English- and Portuguese-language patterns. They will miss things and will occasionally flag something that is not actually a problem, review before acting on them.

## License

MIT, see `LICENSE`.
