#!/usr/bin/env node
// apply.mjs
// Capability E: apply the safe, mechanical corrections found by audit.mjs
// and migrate-models.mjs, reversibly. Nothing is ever deleted; every file
// this script touches is copied to _archive/apply-<timestamp>/ before being
// overwritten, and a report.json of every change is written alongside.
//
// Two kinds of correction, both mechanical (no content judgment required):
//   1. conditional-frontmatter: add a `paths:` block to a rule that
//      audit.mjs's C3 heuristic flagged as dedicated to one file type.
//   2. model-migration: replace outdated/retired model IDs found inside
//      the config itself (CLAUDE.md, rules/, references/).
//
// Only (2) runs by default. (1) requires --conditional-frontmatter, because
// deciding a rule is conditional is a judgment about meaning, not a mechanical
// edit: a wrong glob switches the rule off for most sessions and the byte count
// goes down while the behaviour quietly degrades.
//
// Dead pointers, duplication candidates, and contradiction candidates are
// NOT applied here: fixing those requires a human decision about what the
// content should say. apply.mjs only ever performs changes that cannot lose
// information or change meaning.
//
// Usage:
//   node scripts/apply.mjs [--dir <config-dir>] [--apply] [--json]
//                          [--conditional-frontmatter] [--skip-migrate-models]
//
// Default is dry-run (prints the plan, writes nothing).

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir, flagValue } from './lib/config-dir.mjs';
import { createTranslator } from './lib/i18n.mjs';
import { measureConfig, findConditionalCandidates } from './lib/audit-core.mjs';
import { findModelIdIssues, buildBoundaryRegex } from './lib/model-ids.mjs';

function parseArgs(argv) {
  return {
    configDir: resolveConfigDir(argv),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    // Opt IN, not opt out. Adding paths: to a rule decides that the rule is
    // irrelevant to every session that does not touch those globs, and getting
    // that wrong silently disables the user's instructions. That is a content
    // judgment, so it never happens unless explicitly asked for.
    conditionalFrontmatter: argv.includes('--conditional-frontmatter'),
    skipMigrateModels: argv.includes('--skip-migrate-models'),
  };
}

function buildFrontmatterBlock(suggestedPaths) {
  const lines = ['---', 'paths:'];
  for (const p of suggestedPaths) lines.push(`  - "${p}"`);
  lines.push('---', '');
  return lines.join('\n');
}

// paths: frontmatter is a rules/ mechanism. A file that CLAUDE.md pulls in
// with @import does NOT obey it: writing frontmatter there would look like a
// saving, load exactly the same bytes on every session, and teach the user to
// distrust the tool. The remedy for an imported file is in audit.mjs's
// import-demotion section (delete the @import line), which is a content
// decision and stays manual.
//
// The filter therefore has to test the thing the guarantee is about. "Lives
// under rules/" is NOT the same claim as "is not imported": the two overlap for
// most configs and come apart exactly where it hurts, on a rules/ file that
// CLAUDE.md also pulls in with @rules/x.md. Writing frontmatter there gates
// nothing, grows the file by the size of the YAML block that gets inlined as
// literal text, and -- worst of all -- makes the next audit reclassify it as a
// conditional rule and drop it from the budget. The tool would report a saving
// while re-creating the very under-reporting this whole change exists to fix.
// So both conditions are checked, mechanically, on the resolved path.
function planConditionalFrontmatter(measured) {
  const rulePaths = new Set(measured.rules.map((r) => path.resolve(r.path)));
  const importedPaths = measured.importedPaths ?? new Set();
  return findConditionalCandidates(measured)
    .map((c) => ({
      kind: 'conditional-frontmatter',
      relFile: c.file,
      file: path.join(measured.configDir, c.file),
      detail: `${c.category} content (${c.hits} keyword hits)`,
      suggestedPaths: c.suggestedPaths,
    }))
    .filter((item) => {
      const abs = path.resolve(item.file);
      return rulePaths.has(abs) && !importedPaths.has(abs);
    });
}

function configScanTargets(measured) {
  return [
    { rel: 'CLAUDE.md', abs: measured.claudeMdPath, content: measured.claudeMdContent ?? '' },
    ...measured.alwaysLoadedRules.map((r) => ({ rel: `rules/${r.name}`, abs: r.path, content: r.content })),
    ...measured.conditionalRules.map((r) => ({ rel: `rules/${r.name}`, abs: r.path, content: r.content })),
    ...measured.referenceFiles.map((r) => ({
      rel: `references/${r.name}`,
      abs: r.path,
      content: fs.readFileSync(r.path, 'utf8'),
    })),
  ];
}

function planModelMigration(measured) {
  const plan = [];
  for (const target of configScanTargets(measured)) {
    const issues = findModelIdIssues(target.content);
    if (issues.length === 0) continue;
    plan.push({
      kind: 'model-migration',
      relFile: target.rel,
      file: target.abs,
      detail: issues.map((i) => `${i.id} -> ${i.replacement} (${i.severity})`).join('; '),
      issues,
    });
  }
  return plan;
}

function nextContentFor(item, original) {
  if (item.kind === 'conditional-frontmatter') {
    if (original.startsWith('---')) return null; // already has frontmatter, do not risk corrupting it
    return buildFrontmatterBlock(item.suggestedPaths) + '\n' + original;
  }
  let updated = original;
  for (const issue of item.issues) {
    updated = updated.replace(buildBoundaryRegex(issue.id), issue.replacement);
  }
  return updated === original ? null : updated;
}

function applyPlanItem(item, configDir, backupRoot) {
  const original = fs.readFileSync(item.file, 'utf8');
  const updated = nextContentFor(item, original);
  if (updated === null) {
    const reason = item.kind === 'conditional-frontmatter'
      ? 'file already starts with frontmatter'
      : 'no textual change applied';
    return { ...item, skipped: true, reason };
  }

  const rel = path.relative(configDir, item.file);
  const dest = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(item.file, dest);
  fs.writeFileSync(item.file, updated, 'utf8');
  return { ...item, skipped: false, backupPath: dest };
}

function printPlan(t, configDir, plan) {
  console.log(t('apply.title'));
  console.log(t('apply.configDir', { dir: configDir }));
  console.log(t('apply.modeDryRun'));
  console.log('');
  if (plan.length === 0) {
    console.log(t('apply.none'));
    console.log(t('apply.noneNote'));
    return;
  }
  console.log(t('apply.planned', { count: plan.length }));
  for (const item of plan) {
    console.log(`  [${item.kind}] ${item.relFile}: ${item.detail}`);
  }
}

function printApplied(t, applied, backupRoot) {
  const changed = applied.filter((a) => !a.skipped).length;
  console.log(t('apply.applied', { count: changed, backupRoot }));
  for (const a of applied) {
    if (a.skipped) console.log(t('apply.skipped', { file: a.relFile, reason: a.reason }));
    else console.log(t('apply.updated', { file: a.relFile, kind: a.kind }));
  }
}

function runApply(t, configDir, plan, json) {
  if (plan.length === 0) {
    if (json) console.log(JSON.stringify({ configDir, apply: true, applied: [] }, null, 2));
    else console.log(t('apply.nothing'));
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(configDir, '_archive', `apply-${timestamp}`);
  const applied = plan.map((item) => applyPlanItem(item, configDir, backupRoot));

  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(
    path.join(backupRoot, 'report.json'),
    JSON.stringify({ configDir, timestamp, applied }, null, 2),
    'utf8',
  );

  if (json) console.log(JSON.stringify({ configDir, timestamp, backupRoot, applied }, null, 2));
  else printApplied(t, applied, backupRoot);
}

function main() {
  const argv = process.argv.slice(2);
  const { configDir, apply, json, conditionalFrontmatter, skipMigrateModels } = parseArgs(argv);

  // Same rule as audit.mjs: the language comes from the config being acted on,
  // so operating on someone else's config speaks that config's language. This
  // is the script that WRITES, so its warnings are the ones that most need to
  // be readable by whoever owns the config.
  const { t } = createTranslator({ explicit: flagValue(argv, '--lang'), configDir });

  const measured = measureConfig(configDir);
  const plan = [
    ...(conditionalFrontmatter ? planConditionalFrontmatter(measured) : []),
    ...(skipMigrateModels ? [] : planModelMigration(measured)),
  ];

  if (!apply) {
    if (json) console.log(JSON.stringify({ configDir, apply: false, plan }, null, 2));
    else {
      printPlan(t, configDir, plan);
      console.log('');
      console.log(t('apply.dryRunOnly'));
    }
    return;
  }

  runApply(t, configDir, plan, json);
}

main();
