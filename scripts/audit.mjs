#!/usr/bin/env node
// audit.mjs
// Capabilities A, B, C: measure the config's context budget, find dead
// pointers, and flag duplication / contradiction / conditional-rule
// candidates. Read-only. Never writes anything.
//
// Usage:
//   node scripts/audit.mjs [--dir <config-dir>] [--json]
//
// With no --dir, resolves CLAUDE_CODE_CONFIG_DIR, falling back to ~/.claude.

import { resolveConfigDir } from './lib/config-dir.mjs';
import {
  measureConfig,
  findDeadPointers,
  findDuplication,
  findContradictionCandidates,
  findConditionalCandidates,
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
      },
      threeLayerArchitecture: measured.threeLayer,
      deadPointers: findDeadPointers(measured),
      duplicationCandidates: findDuplication(measured),
      contradictionCandidates: findContradictionCandidates(measured),
      conditionalRuleCandidates: findConditionalCandidates(measured),
    },
  };
}

function archLine(measured) {
  const layer = measured.threeLayer;
  if (!layer.claudeMd) return 'no CLAUDE.md found at this path';
  if (!layer.rulesDir) return 'CLAUDE.md present, no rules/ directory (single-layer)';
  if (!layer.referencesDir && !layer.hasConditionalRules) {
    return 'CLAUDE.md + rules/ present, no references/ and no conditional rules (two-layer, references missing)';
  }
  if (!layer.referencesDir) return 'CLAUDE.md + rules/ (with conditional rules) present, no references/ directory';
  return 'full three-layer architecture in place (CLAUDE.md -> rules/ -> references/)';
}

function printBudget(result, measured) {
  const b = result.budget;
  console.log('CONTEXT BUDGET');
  console.log(
    `  Always loaded:          ${b.alwaysLoadedBytes} bytes` +
    ` (CLAUDE.md: ${b.claudeMdBytes}, rules: ${b.alwaysLoadedRulesBytes} across ${b.alwaysLoadedRulesCount} file(s))`,
  );
  console.log(`  Conditional (paths:):   ${b.conditionalBytes} bytes across ${b.conditionalRulesCount} file(s)`);
  console.log(`  On demand (references): ${b.referencesBytes} bytes across ${b.referencesCount} file(s)`);
  console.log(`  Skills installed: ${b.skillsCount}`);
  console.log(`  Context cards: ${b.contextCardsCount} (${b.contextCardsBytes} bytes, loaded conditionally by trigger, not part of always-loaded budget)`);
  console.log('');
  printAlwaysLoadedBreakdown(measured);
}

// The README tells the user to look at the largest always-loaded documents to
// decide what to distill, so the tool has to actually produce that list. A total
// with no breakdown gives the number and hides where to start.
function printAlwaysLoadedBreakdown(m) {
  const docs = [
    ...(m.claudeMdContent ? [{ name: 'CLAUDE.md', bytes: m.claudeMdBytes, via: '' }] : []),
    ...m.alwaysLoadedRules.map((r) => ({ name: `rules/${r.name}`, bytes: r.bytes, via: '' })),
    ...(m.imported ?? []).map((f) => ({ name: f.name, bytes: f.bytes, via: ' (@import)' })),
  ].sort((a, b2) => b2.bytes - a.bytes);
  if (docs.length === 0) return;
  const total = docs.reduce((s2, d) => s2 + d.bytes, 0) || 1;
  console.log('ALWAYS-LOADED DOCUMENTS, LARGEST FIRST');
  for (const d of docs.slice(0, 12)) {
    const share = ((d.bytes / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${String(d.bytes).padStart(7)} bytes  ${share}%  ${d.name}${d.via}`);
  }
  if (docs.length > 12) console.log(`  ... and ${docs.length - 12} more`);
  console.log('');

  const broken = m.brokenImports ?? [];
  if (broken.length) {
    console.log('BROKEN @import');
    console.log(`  ${broken.length} import(s) point to a file that does not exist. The instruction`);
    console.log('  silently never loads, which is the worst kind of config defect:');
    for (const b2 of broken) console.log(`    @${b2.spec}  (line ${b2.line})`);
    console.log('');
  }

  const claiming = m.importedClaimingPaths ?? [];
  if (claiming.length) {
    console.log('paths: ON AN IMPORTED FILE (has no effect)');
    console.log('  These files carry a paths: frontmatter but are pulled in with @import.');
    console.log('  Claude Code strips the frontmatter before injecting, so the field is');
    console.log('  swallowed and the file keeps loading on every turn. To make it');
    console.log('  conditional for real, move it into rules/:');
    for (const c of claiming) console.log(`    ${c.name}`);
    console.log('');
  }
}

function printArchitecture(measured) {
  console.log('THREE-LAYER ARCHITECTURE');
  console.log(`  CLAUDE.md present: ${measured.threeLayer.claudeMd ? 'yes' : 'no'}`);
  console.log(`  rules/ present: ${measured.threeLayer.rulesDir ? 'yes' : 'no'}`);
  console.log(`  references/ present: ${measured.threeLayer.referencesDir ? 'yes' : 'no'}`);
  console.log(`  Verdict: ${archLine(measured)}`);
  console.log('');
}

function printDeadPointers(deadPointers) {
  console.log('DEAD POINTERS (capability B)');
  if (deadPointers.length === 0) {
    console.log('  None found. Every rules/, references/, hooks/ and skills/ path cited in CLAUDE.md or a rule resolves to a real file.');
  } else {
    console.log(`  ${deadPointers.length} dead pointer(s):`);
    for (const d of deadPointers) {
      console.log(`    ${d.target} (cited in ${d.citedIn}) -> does not exist at ${d.resolvedPath}`);
    }
  }
  console.log('');
}

function printDuplication(candidates) {
  console.log('DUPLICATION CANDIDATES (capability C1, heuristic)');
  if (candidates.length === 0) {
    console.log('  None found above the similarity threshold.');
  } else {
    console.log(`  ${candidates.length} near-identical sentence pair(s) between CLAUDE.md and an always-loaded rule:`);
    for (const c of candidates.slice(0, 20)) {
      console.log(`    ${c.file} (similarity ${c.score})`);
      console.log(`      CLAUDE.md: "${c.claudeLine}"`);
      console.log(`      ${c.file}: "${c.ruleLine}"`);
    }
    if (candidates.length > 20) console.log(`    ... and ${candidates.length - 20} more`);
  }
  console.log('');
}

function printContradictions(candidates) {
  console.log('CONTRADICTION CANDIDATES (capability C2, heuristic, needs human review)');
  if (candidates.length === 0) {
    console.log('  None found. (This checks a fixed list of never/always + action-verb pairs, it is not exhaustive.)');
  } else {
    console.log(`  ${candidates.length} candidate(s) where "never" and "always" apply to the same action across two always-loaded docs:`);
    for (const c of candidates.slice(0, 20)) {
      console.log(`    [${c.stem}] overlap ${c.overlap}`);
      console.log(`      ${c.neverFile}: "${c.neverLine}"`);
      console.log(`      ${c.alwaysFile}: "${c.alwaysLine}"`);
    }
    if (candidates.length > 20) console.log(`    ... and ${candidates.length - 20} more`);
  }
  console.log('');
}

function printConditionalCandidates(candidates) {
  console.log('CONDITIONAL-RULE CANDIDATES (capability C3)');
  if (candidates.length === 0) {
    console.log('  None found. No always-loaded rule looks 100% dedicated to a single file type.');
  } else {
    console.log(`  ${candidates.length} rule(s) that look dedicated to one file type and could gain a paths: frontmatter:`);
    for (const c of candidates) {
      console.log(`    ${c.file}: ${c.category} content (${c.hits} keyword hits) -> suggested paths: ${c.suggestedPaths.join(', ')}`);
    }
  }
  console.log('');
}

function printTextReport(measured, result) {
  console.log('Claude Optimizer -- Config Audit');
  console.log(`Config dir: ${result.configDir}`);
  console.log('');
  printBudget(result, measured);
  printArchitecture(measured);
  printDeadPointers(result.deadPointers);
  printDuplication(result.duplicationCandidates);
  printContradictions(result.contradictionCandidates);
  printConditionalCandidates(result.conditionalRuleCandidates);
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
  printTextReport(measured, result);
}

main();
