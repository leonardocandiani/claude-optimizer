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
// Dead pointers, duplication candidates, and contradiction candidates are
// NOT applied here: fixing those requires a human decision about what the
// content should say. apply.mjs only ever performs changes that cannot lose
// information or change meaning.
//
// Usage:
//   node scripts/apply.mjs [--dir <config-dir>] [--apply] [--json]
//                          [--skip-conditional-frontmatter] [--skip-migrate-models]
//
// Default is dry-run (prints the plan, writes nothing).

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './lib/config-dir.mjs';
import { measureConfig, findConditionalCandidates } from './lib/audit-core.mjs';
import { findModelIdIssues, buildBoundaryRegex } from './lib/model-ids.mjs';

function parseArgs(argv) {
  return {
    configDir: resolveConfigDir(argv),
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    skipConditionalFrontmatter: argv.includes('--skip-conditional-frontmatter'),
    skipMigrateModels: argv.includes('--skip-migrate-models'),
  };
}

function buildFrontmatterBlock(suggestedPaths) {
  const lines = ['---', 'paths:'];
  for (const p of suggestedPaths) lines.push(`  - "${p}"`);
  lines.push('---', '');
  return lines.join('\n');
}

function planConditionalFrontmatter(measured) {
  return findConditionalCandidates(measured).map((c) => ({
    kind: 'conditional-frontmatter',
    relFile: c.file,
    file: path.join(measured.configDir, c.file),
    detail: `${c.category} content (${c.hits} keyword hits)`,
    suggestedPaths: c.suggestedPaths,
  }));
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

function printPlan(configDir, plan) {
  console.log('Claude Optimizer -- Apply');
  console.log(`Config dir: ${configDir}`);
  console.log('Mode: dry-run');
  console.log('');
  if (plan.length === 0) {
    console.log('No safe, mechanical corrections found to apply.');
    console.log('(Dead pointers, duplication, and contradiction candidates need a human decision, apply.mjs does not touch those.)');
    return;
  }
  console.log(`${plan.length} correction(s) planned:`);
  for (const item of plan) {
    console.log(`  [${item.kind}] ${item.relFile}: ${item.detail}`);
  }
}

function printApplied(applied, backupRoot) {
  const changed = applied.filter((a) => !a.skipped).length;
  console.log(`Applied ${changed} change(s). Backups + report: ${backupRoot}`);
  for (const a of applied) {
    if (a.skipped) console.log(`  SKIPPED ${a.relFile}: ${a.reason}`);
    else console.log(`  UPDATED ${a.relFile} (${a.kind})`);
  }
}

function runApply(configDir, plan, json) {
  if (plan.length === 0) {
    if (json) console.log(JSON.stringify({ configDir, apply: true, applied: [] }, null, 2));
    else console.log('Nothing to apply.');
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
  else printApplied(applied, backupRoot);
}

function main() {
  const argv = process.argv.slice(2);
  const { configDir, apply, json, skipConditionalFrontmatter, skipMigrateModels } = parseArgs(argv);

  const measured = measureConfig(configDir);
  const plan = [
    ...(skipConditionalFrontmatter ? [] : planConditionalFrontmatter(measured)),
    ...(skipMigrateModels ? [] : planModelMigration(measured)),
  ];

  if (!apply) {
    if (json) console.log(JSON.stringify({ configDir, apply: false, plan }, null, 2));
    else {
      printPlan(configDir, plan);
      console.log('');
      console.log('Dry-run only. Re-run with --apply to write changes (backups go to _archive/ before any write).');
    }
    return;
  }

  runApply(configDir, plan, json);
}

main();
