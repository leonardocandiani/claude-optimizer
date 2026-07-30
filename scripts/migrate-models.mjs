#!/usr/bin/env node
// migrate-models.mjs
// Capability D: scan one or more directories for outdated/retired Claude
// model IDs and, when it finds them, flag the known Opus 5 API breaking
// changes worth checking by hand.
//
// Usage:
//   node scripts/migrate-models.mjs [--dir <path>]... [--apply] [--json]
//
// With no --dir, scans only the paths that make up the user's own config
// (CLAUDE.md, rules/, references/, commands/, agents/, hooks/, context/,
// output-styles/, settings.json) inside the resolved config directory, not
// the whole ~/.claude runtime data tree (session-env, projects, telemetry,
// caches, ...) and not the bundled skills/ library, which often ships its
// own migration-guide docs that intentionally mention retired model IDs.
// Pass --dir explicitly (repeatable) to scan project directories in full,
// including ~/.claude/skills/<name> if you want to check a specific skill.
//
// Default is dry-run: nothing is written unless --apply is passed, and even
// then every changed file is backed up first under
// _archive/model-migration-<timestamp>/ next to the directory it came from.

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir, defaultConfigScanRoots } from './lib/config-dir.mjs';
import { walkFiles } from './lib/fs-walk.mjs';
import {
  findModelIdIssues,
  findBreakingPatternHints,
  fileLooksAnthropicRelated,
  buildBoundaryRegex,
} from './lib/model-ids.mjs';

function parseArgs(argv) {
  const dirs = [];
  let apply = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      dirs.push(path.resolve(argv[++i]));
    } else if (argv[i] === '--apply') {
      apply = true;
    } else if (argv[i] === '--json') {
      json = true;
    }
  }
  const explicit = dirs.length > 0;
  const roots = explicit ? dirs : defaultConfigScanRoots(resolveConfigDir(argv));
  return { roots, explicit, apply, json };
}

function scanFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const idIssues = findModelIdIssues(content);
  const anthropicRelated = idIssues.length > 0 || fileLooksAnthropicRelated(content);
  const breaking = anthropicRelated ? findBreakingPatternHints(content) : [];
  return { idIssues, breaking };
}

// A scan root can be a single file (CLAUDE.md, settings.json) or a
// directory (rules/, references/, ...). Backups are always keyed relative
// to a directory, so a file root backs up relative to its parent.
function filesUnderRoot(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return null;
  }
  if (stat.isFile()) return { backupBase: path.dirname(root), files: [root] };
  return { backupBase: root, files: [...walkFiles(root)] };
}

function scanRoots(roots) {
  const findings = [];
  let filesScanned = 0;
  for (const root of roots) {
    const info = filesUnderRoot(root);
    if (!info) {
      console.error(`Warning: path not found, skipping: ${root}`);
      continue;
    }
    for (const file of info.files) {
      filesScanned++;
      const { idIssues, breaking } = scanFile(file);
      if (idIssues.length > 0 || breaking.length > 0) {
        findings.push({ file, rootDir: info.backupBase, idIssues, breaking });
      }
    }
  }
  return { findings, filesScanned };
}

function severityCounts(findings) {
  const counts = { retired: 0, deprecating: 0, outdated: 0 };
  for (const f of findings) {
    for (const issue of f.idIssues) counts[issue.severity]++;
  }
  return counts;
}

function severityTag(severity) {
  if (severity === 'retired') return 'RETIRED (404)';
  if (severity === 'deprecating') return 'DEPRECATING';
  return 'OUTDATED';
}

function printFinding(f) {
  console.log(f.file);
  for (const issue of f.idIssues) {
    console.log(`  line ${issue.line}: [${severityTag(issue.severity)}] ${issue.id} -> ${issue.replacement}`);
  }
  for (const hint of f.breaking) {
    console.log(`  line ${hint.line}: [API CHECK] ${hint.message}`);
  }
  console.log('');
}

function printOpus5Checklist() {
  console.log('Opus 5 migration checklist (verify by hand, these are not auto-detected):');
  console.log('  - budget_tokens is rejected with 400. Use thinking: {type: "adaptive"}.');
  console.log('  - temperature / top_p / top_k are rejected with 400. Remove them.');
  console.log('  - assistant-turn prefill (last message with role "assistant") is rejected with 400.');
  console.log('  - thinking runs on by default and shares max_tokens with the visible response; a low max_tokens can now truncate mid-answer.');
  console.log('  - if your loop expects one tool_use per turn, set tool_choice: {type: "auto", disable_parallel_tool_use: true}.');
  console.log('');
}

function printReport({ roots, filesScanned, findings, apply }) {
  console.log('Claude Optimizer -- Model ID Migration Scan');
  console.log(`Scanned: ${roots.join(', ')}`);
  console.log(`Files scanned: ${filesScanned}`);
  console.log(`Mode: ${apply ? 'APPLY (writing changes, backups under _archive/)' : 'dry-run (no changes written)'}`);
  console.log('');

  if (findings.length === 0) {
    console.log('No outdated or retired model IDs found. No breaking-change patterns flagged.');
    return;
  }

  const counts = severityCounts(findings);
  console.log(`Model ID references found: ${counts.retired} retired (404), ${counts.deprecating} deprecating, ${counts.outdated} outdated (active, superseded)`);
  console.log('');

  for (const f of findings) printFinding(f);

  const touchesOpus5 = findings.some((f) => f.idIssues.some((i) => i.replacement === 'claude-opus-5'));
  if (touchesOpus5) printOpus5Checklist();

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write replacements (each changed file is backed up first).');
  }
}

function applyReplacements(findings, timestamp) {
  let filesChanged = 0;
  let replacementsMade = 0;

  for (const f of findings) {
    if (f.idIssues.length === 0) continue;

    const original = fs.readFileSync(f.file, 'utf8');
    let updated = original;
    let appliedCount = 0;
    for (const issue of f.idIssues) {
      const before = updated;
      updated = updated.replace(buildBoundaryRegex(issue.id), issue.replacement);
      if (updated !== before) appliedCount++;
    }
    if (updated === original) continue;

    const backupRoot = path.join(f.rootDir, '_archive', `model-migration-${timestamp}`);
    const rel = path.relative(f.rootDir, f.file);
    const dest = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.file, dest);
    fs.writeFileSync(f.file, updated, 'utf8');

    filesChanged++;
    replacementsMade += appliedCount;
    console.log(`  UPDATED ${f.file} (${appliedCount} replacement(s), backup: ${dest})`);
  }

  console.log('');
  console.log(`Applied: ${filesChanged} file(s) changed, ${replacementsMade} replacement(s) total.`);
}

function main() {
  const argv = process.argv.slice(2);
  const { roots, apply, json } = parseArgs(argv);

  const { findings, filesScanned } = scanRoots(roots);

  if (json) {
    console.log(JSON.stringify({ roots, filesScanned, apply, findings }, null, 2));
  } else {
    printReport({ roots, filesScanned, findings, apply });
  }

  if (apply && findings.length > 0) {
    if (!json) console.log('');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    applyReplacements(findings, timestamp);
  }
}

main();
