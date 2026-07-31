#!/usr/bin/env node
// audit.mjs
// Measures the config's context budget, lists what makes it up, finds dead
// pointers, and flags duplication / contradiction / conditional-rule
// candidates. Read-only. Never writes anything.
//
// Usage:
//   node scripts/audit.mjs [--dir <config-dir>] [--json] [--lang <code>]
//
// With no --dir, resolves CLAUDE_CODE_CONFIG_DIR, falling back to ~/.claude.
//
// The text report is translated (see locales/). Language resolution is the
// same one impact.mjs uses: --lang, then CLAUDE_OPTIMIZER_LANG, then the
// `language` field of the audited settings.json, then LC_ALL/LC_MESSAGES/LANG,
// then English. --json is the machine surface and stays untranslated.
//
// Numbers here are deliberately NOT locale-formatted, unlike impact.mjs. An
// audit figure gets pasted into issues, diffs and commit messages, and
// "99.754" versus "99,754" is the same number to a machine and two different
// ones to a person reading in another locale. Raw digits are unambiguous.

import { resolveConfigDir, flagValue } from './lib/config-dir.mjs';
import { createTranslator } from './lib/i18n.mjs';
import {
  measureConfig,
  alwaysLoadedInventory,
  findDeadPointers,
  findDuplication,
  findContradictionCandidates,
  findConditionalCandidates,
  findImportDemotionCandidates,
} from './lib/audit-core.mjs';

function buildResult(configDir) {
  const measured = measureConfig(configDir);
  return {
    measured,
    result: {
      configDir,
      budget: {
        claudeMdBytes: measured.claudeMdBytes,
        alwaysLoadedRulesBytes: measured.alwaysLoadedRulesBytes,
        alwaysLoadedRulesCount: measured.alwaysLoadedRules.length,
        alwaysLoadedBytes: measured.alwaysLoadedBytes,
        conditionalBytes: measured.conditionalBytes,
        conditionalRulesCount: measured.conditionalRules.length,
        referencesBytes: measured.referencesBytes,
        referencesCount: measured.referenceFiles.length,
        skillsCount: measured.skills.length,
        contextCardsCount: measured.contextCardFiles.length,
        contextCardsBytes: measured.contextCardsBytes,
        // @import files: always loaded, exactly like CLAUDE.md itself.
        importedBytes: measured.importedBytes,
        importedCount: measured.importedDocs.length,
        // Structurally zero since imports were settled: a file reached by @
        // is never conditional. Kept so existing consumers do not break.
        importedConditionalBytes: measured.importedConditionalBytes,
        importedConditionalCount: measured.importedConditionalDocs.length,
        importsIgnoringPathsCount: measured.importsIgnoringPaths.length,
        brokenImportsCount: measured.missingImports.length,
      },
      threeLayerArchitecture: measured.threeLayer,
      // The breakdown behind alwaysLoadedBytes. A total on its own says a diet
      // is needed and nothing about where to start.
      alwaysLoadedDocs: alwaysLoadedInventory(measured),
      importedDocs: measured.importedDocs.map((d) => ({
        file: `@${d.rel}`, bytes: d.bytes, depth: d.depth, importedBy: d.citedIn,
      })),
      importsIgnoringPaths: measured.importsIgnoringPaths,
      brokenImports: measured.missingImports.map((m) => ({
        target: `@${m.spec}`, citedIn: m.citedIn, resolvedPath: m.resolvedPath, reason: m.reason,
      })),
      deadPointers: findDeadPointers(measured),
      duplicationCandidates: findDuplication(measured),
      contradictionCandidates: findContradictionCandidates(measured),
      conditionalRuleCandidates: findConditionalCandidates(measured),
      importDemotionCandidates: findImportDemotionCandidates(measured),
    },
  };
}

function archVerdict(t, measured) {
  const layer = measured.threeLayer;
  if (!layer.claudeMd) return t('audit.arch.v.noClaudeMd');
  // rules/ is one way to build layer 2, @import lines inside CLAUDE.md are
  // the other, and the runtime treats both the same way. Calling an
  // import-based config "single-layer" because it has no rules/ directory
  // would be flatly wrong.
  if (!layer.rulesDir) {
    if (!layer.importLayer) return t('audit.arch.v.single');
    return layer.onDemandDocs ? t('audit.arch.v.importFull') : t('audit.arch.v.importTwo');
  }
  const suffix = layer.importLayer ? t('audit.arch.v.plusImports') : '';
  if (!layer.referencesDir && !layer.hasConditionalRules) return t('audit.arch.v.noRefsNoCond') + suffix;
  if (!layer.referencesDir) return t('audit.arch.v.noRefs') + suffix;
  return t('audit.arch.v.full') + suffix;
}

function printBudget(t, result) {
  const b = result.budget;
  console.log(t('audit.budget.heading'));
  // The @ imports belong in this line, not in a footnote: they are inlined
  // into every session exactly like CLAUDE.md itself.
  const imported = b.importedCount > 0
    ? t('audit.budget.alwaysImported', { bytes: b.importedBytes, count: b.importedCount })
    : '';
  console.log(t('audit.budget.always', {
    bytes: b.alwaysLoadedBytes,
    claudeMd: b.claudeMdBytes,
    rules: b.alwaysLoadedRulesBytes,
    rulesCount: b.alwaysLoadedRulesCount,
    imported,
  }));
  console.log(t('audit.budget.conditional', { bytes: b.conditionalBytes, count: b.conditionalRulesCount }));
  console.log(t('audit.budget.onDemand', { bytes: b.referencesBytes, count: b.referencesCount }));
  console.log(t('audit.budget.skills', { count: b.skillsCount }));
  // Context cards only sit outside the always-loaded budget when CLAUDE.md
  // does not import them; an imported card is inside the line above.
  const cardKey = b.importedCount > 0 ? 'audit.budget.cardsWithImports' : 'audit.budget.cards';
  console.log(t(cardKey, { count: b.contextCardsCount, bytes: b.contextCardsBytes }));
  if (b.brokenImportsCount > 0) console.log(t('audit.budget.broken', { count: b.brokenImportsCount }));
  console.log('');
}

// The list the README tells the user to read before deciding what to distill,
// and the thing that turns an opaque total into a traceable one.
function printInventory(t, docs, totalBytes) {
  console.log(t('audit.inventory.heading'));
  if (docs.length === 0) {
    console.log(t('audit.inventory.empty'));
    console.log('');
    return;
  }
  console.log(t('audit.inventory.intro', { count: docs.length, bytes: totalBytes }));
  console.log(t('audit.inventory.columns'));
  for (const d of docs) {
    const bytes = String(d.bytes).padStart(9);
    const share = `${d.percent.toFixed(1)}%`.padStart(6);
    console.log(`  ${bytes}  ${share}  ${d.file}`);
  }
  console.log('');
}

function printArchitecture(t, measured) {
  const yes = t('audit.yes');
  const no = t('audit.no');
  console.log(t('audit.arch.heading'));
  console.log(t('audit.arch.claudeMd', { value: measured.threeLayer.claudeMd ? yes : no }));
  console.log(t('audit.arch.rules', { value: measured.threeLayer.rulesDir ? yes : no }));
  console.log(t('audit.arch.references', { value: measured.threeLayer.referencesDir ? yes : no }));
  console.log(t('audit.arch.imports', {
    value: measured.threeLayer.importLayer
      ? t('audit.arch.importsYes', { count: measured.importedDocs.length })
      : no,
  }));
  console.log(t('audit.arch.verdictLabel', { verdict: archVerdict(t, measured) }));
  console.log('');
}

// Its own section, not a row inside the dead-pointer list. A broken import is
// not a stale mention in prose: the runtime tries to inline the file, fails
// without a word, and the rule stops existing while the user still believes it
// is loaded on every session.
function printBrokenImports(t, brokenImports) {
  if (brokenImports.length === 0) return; // silence when there is nothing to say
  console.log(t('audit.broken.heading'));
  console.log(t('audit.broken.intro', { count: brokenImports.length }));
  for (const b of brokenImports) {
    const why = b.reason === 'non-text'
      ? t('audit.broken.nonText', { path: b.resolvedPath })
      : t('audit.broken.notFound', { path: b.resolvedPath });
    console.log(t('audit.broken.line', { target: b.target, citedIn: b.citedIn, why }));
  }
  console.log('');
}

function printDeadPointers(t, deadPointers) {
  console.log(t('audit.dead.heading'));
  if (deadPointers.length === 0) {
    console.log(t('audit.dead.none'));
  } else {
    console.log(t('audit.dead.intro', { count: deadPointers.length }));
    for (const d of deadPointers) {
      console.log(t('audit.dead.line', { target: d.target, citedIn: d.citedIn, path: d.resolvedPath }));
    }
  }
  console.log('');
}

function printDuplication(t, candidates) {
  console.log(t('audit.dup.heading'));
  if (candidates.length === 0) {
    console.log(t('audit.dup.none'));
  } else {
    console.log(t('audit.dup.intro', { count: candidates.length }));
    for (const c of candidates.slice(0, 20)) {
      console.log(t('audit.dup.head', { file: c.file, score: c.score }));
      console.log(t('audit.dup.line', { file: 'CLAUDE.md', line: c.claudeLine }));
      console.log(t('audit.dup.line', { file: c.file, line: c.ruleLine }));
    }
    if (candidates.length > 20) console.log(t('audit.more', { count: candidates.length - 20 }));
  }
  console.log('');
}

function printContradictions(t, candidates) {
  console.log(t('audit.contra.heading'));
  if (candidates.length === 0) {
    console.log(t('audit.contra.none'));
  } else {
    console.log(t('audit.contra.intro', { count: candidates.length }));
    for (const c of candidates.slice(0, 20)) {
      console.log(t('audit.contra.head', { stem: c.stem, overlap: c.overlap }));
      console.log(t('audit.contra.line', { file: c.neverFile, line: c.neverLine }));
      console.log(t('audit.contra.line', { file: c.alwaysFile, line: c.alwaysLine }));
    }
    if (candidates.length > 20) console.log(t('audit.more', { count: candidates.length - 20 }));
    console.log(t('audit.caution1'));
    console.log(t('audit.caution2'));
  }
  console.log('');
}

function printConditionalCandidates(t, candidates) {
  console.log(t('audit.cond.heading'));
  if (candidates.length === 0) {
    console.log(t('audit.cond.none'));
  } else {
    console.log(t('audit.cond.intro', { count: candidates.length }));
    for (const c of candidates) {
      console.log(t('audit.cond.line', { file: c.file, category: c.category, hits: c.hits }));
      console.log(t('audit.cond.action', { paths: c.suggestedPaths.join(', ') }));
    }
    console.log(t('audit.caution1'));
    console.log(t('audit.caution2'));
  }
  console.log('');
}

// Separate section with a different remedy: paths: is a rules/ feature and an
// imported file ignores it, so suggesting frontmatter here would be advice that
// quietly does nothing.
//
// This section carries the same caution the contradiction section does, and it
// states a CANDIDATE rather than an order. The reason is a real false positive:
// on the maintainer's own config it printed "remove the @import line" for
// context/watchdog-nome-generico-cross-project.md, a live safety rule that only
// looked like a Python rule because it quotes `coletor.py` and `main.py` as the
// anti-pattern it forbids. Obeying that line would have switched off a working
// protection. The detector is stricter now (examples and negations no longer
// count), but a heuristic that instructs instead of proposing is one bad
// classification away from doing damage, so the verb changed too.
function printImportDemotionCandidates(t, candidates) {
  console.log(t('audit.demote.heading'));
  if (candidates.length === 0) {
    console.log(t('audit.demote.none'));
  } else {
    console.log(t('audit.demote.intro', { count: candidates.length }));
    console.log(t('audit.demote.remedy'));
    for (const c of candidates) {
      console.log(t('audit.demote.line', {
        file: c.file, category: c.category, hits: c.hits, bytes: c.bytes, importedBy: c.importedBy,
      }));
      console.log(t('audit.demote.action'));
    }
    console.log(t('audit.caution1'));
    console.log(t('audit.caution2'));
  }
  console.log('');
}

// The practical payoff of settling how imports and paths: interact: a file
// whose author believed they had made it conditional, and which is in fact
// fixed weight on every session. Nothing else in the config shows this.
function printIgnoredPaths(t, entries) {
  if (entries.length === 0) return; // silence when there is nothing to say
  console.log(t('audit.ignored.heading'));
  console.log(t('audit.ignored.intro', { count: entries.length }));
  for (const e of entries) {
    console.log(t('audit.ignored.line', { file: e.file, importedBy: e.importedBy, bytes: e.bytes }));
  }
  console.log(t('audit.ignored.remedy1'));
  console.log(t('audit.ignored.remedy2'));
  console.log('');
}

function printTextReport(t, measured, result) {
  console.log(t('audit.title'));
  console.log(t('audit.configDir', { dir: result.configDir }));
  console.log('');
  printBudget(t, result);
  printInventory(t, result.alwaysLoadedDocs, result.budget.alwaysLoadedBytes);
  printArchitecture(t, measured);
  printBrokenImports(t, result.brokenImports);
  printIgnoredPaths(t, result.importsIgnoringPaths);
  printDeadPointers(t, result.deadPointers);
  printDuplication(t, result.duplicationCandidates);
  printContradictions(t, result.contradictionCandidates);
  printConditionalCandidates(t, result.conditionalRuleCandidates);
  if (result.budget.importedCount > 0) printImportDemotionCandidates(t, result.importDemotionCandidates);
}

function main() {
  const argv = process.argv.slice(2);
  const configDir = resolveConfigDir(argv);
  const json = argv.includes('--json');

  const { measured, result } = buildResult(configDir);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // The audited directory is also where the language preference is read from,
  // so auditing someone else's config reports it in that config's language.
  const { t } = createTranslator({ explicit: flagValue(argv, '--lang'), configDir });
  printTextReport(t, measured, result);
}

main();
