#!/usr/bin/env node
// migrate-models.mjs
// Capability D: scan one or more directories for outdated/retired Claude
// model IDs and, when it finds them, flag the known Opus 5 API breaking
// changes worth checking by hand.
//
// Usage:
//   node scripts/migrate-models.mjs [--dir <path>]... [--apply] [--json]
//                                   [--include-runtime] [--lang <code>]
//
// The text report goes through the same translator as audit.mjs and impact.mjs
// (--lang, then CLAUDE_OPTIMIZER_LANG, then the `language` field of the config
// being scanned, then LC_ALL/LC_MESSAGES/LANG, then English). This half of the
// tool is the half that offers to WRITE into the user's own configuration, so
// leaving its risk warnings in a language the owner does not read would mean
// asking them to accept a risk they cannot read. --json is deliberately NOT
// translated: it is a machine interface.
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
// --dir on a config directory is the one case where "in full" is wrong, and
// it used to be taken literally: the walk reached .claude.json, the statistics
// caches and every session transcript under projects/. Rewriting the model ID
// inside a transcript of a session that already ran is not a migration, it is
// editing a historical record. Runtime paths are therefore skipped whenever the
// scanned root sits inside a config directory, the count of skipped files is
// printed before the --apply invitation, and --include-runtime is there for
// anyone who really wants them. Scanning an ordinary project is untouched.
//
// Default is dry-run: nothing is written unless --apply is passed, and even
// then every changed file is backed up first under
// _archive/model-migration-<timestamp>/ next to the directory it came from.

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir, defaultConfigScanRoots, flagValue } from './lib/config-dir.mjs';
import { walkFiles } from './lib/fs-walk.mjs';
import { runtimeFilterFor } from './lib/runtime-paths.mjs';
import { createTranslator } from './lib/i18n.mjs';
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
  let includeRuntime = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      dirs.push(path.resolve(argv[++i]));
    } else if (argv[i] === '--apply') {
      apply = true;
    } else if (argv[i] === '--json') {
      json = true;
    } else if (argv[i] === '--include-runtime') {
      includeRuntime = true;
    }
  }
  const explicit = dirs.length > 0;
  const configDir = resolveConfigDir(argv);
  const roots = explicit ? dirs : defaultConfigScanRoots(configDir);
  // The hint that lets a config directory NOT named `.claude` still be
  // recognised. It must never be the --dir value itself: resolveConfigDir
  // returns --dir when present, so using it here would declare every explicitly
  // scanned directory a config root and start skipping folders called
  // projects/ or cache/ inside ordinary repositories.
  const envConfigDir = process.env.CLAUDE_CODE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CODE_CONFIG_DIR)
    : null;
  return { roots, explicit, apply, json, includeRuntime, configHint: explicit ? envConfigDir : configDir };
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

function scanRoots(roots, { includeRuntime = false, configHint = null, t = null } = {}) {
  const findings = [];
  let filesScanned = 0;
  let filesSkippedRuntime = 0;
  for (const root of roots) {
    const info = filesUnderRoot(root);
    if (!info) {
      console.error(t ? t('migrate.warn.pathNotFound', { root }) : `Warning: path not found, skipping: ${root}`);
      continue;
    }
    // null when this root is not inside a config directory, which is the
    // ordinary-project case: no filtering, full scan, unchanged behaviour.
    const isRuntime = includeRuntime ? null : runtimeFilterFor(root, configHint);
    for (const file of info.files) {
      if (isRuntime && isRuntime(file)) { filesSkippedRuntime++; continue; }
      filesScanned++;
      const { idIssues, breaking } = scanFile(file);
      if (idIssues.length > 0 || breaking.length > 0) {
        findings.push({ file, rootDir: info.backupBase, idIssues, breaking });
      }
    }
  }
  return { findings, filesScanned, filesSkippedRuntime };
}

function severityCounts(findings) {
  const counts = { retired: 0, deprecating: 0, outdated: 0 };
  for (const f of findings) {
    for (const issue of f.idIssues) counts[issue.severity]++;
  }
  return counts;
}

function severityTag(t, severity) {
  if (severity === 'retired') return t('migrate.sev.retired');
  if (severity === 'deprecating') return t('migrate.sev.deprecating');
  return t('migrate.sev.outdated');
}

function printFinding(t, f) {
  console.log(f.file);
  for (const issue of f.idIssues) {
    console.log(t('migrate.finding.id', {
      line: issue.line,
      tag: severityTag(t, issue.severity),
      id: issue.id,
      replacement: issue.replacement,
    }));
  }
  for (const hint of f.breaking) {
    console.log(t('migrate.finding.apiCheck', { line: hint.line, message: t(hint.key) }));
  }
  console.log('');
}

function printOpus5Checklist(t) {
  console.log(t('migrate.checklist.heading'));
  console.log(t('migrate.checklist.budgetTokens'));
  console.log(t('migrate.checklist.sampling'));
  console.log(t('migrate.checklist.prefill'));
  console.log(t('migrate.checklist.thinking'));
  console.log(t('migrate.checklist.parallelTools'));
  console.log('');
}

// One line, printed twice on purpose when it is non-zero: once in the header
// so the file count is honest, and once immediately above the --apply
// invitation, which is the moment someone decides to let this thing write.
function runtimeSkipLine(t, filesSkippedRuntime) {
  return t('migrate.runtimeSkipped', { count: filesSkippedRuntime });
}

function printReport(t, { roots, filesScanned, filesSkippedRuntime, findings, apply }) {
  console.log(t('migrate.title'));
  console.log(t('migrate.scanned', { roots: roots.join(', ') }));
  console.log(t('migrate.filesScanned', { count: filesScanned }));
  if (filesSkippedRuntime > 0) console.log(runtimeSkipLine(t, filesSkippedRuntime));
  console.log(apply ? t('migrate.mode.apply') : t('migrate.mode.dryRun'));
  console.log('');

  // Nothing was read, so "nothing is wrong" is not something this run knows.
  // Printing the clean bill of health here is the difference between a scan
  // that found no problem and a scan that never happened -- and the reader
  // who trusts the closing sentence never goes back to check the counter.
  if (filesScanned === 0) {
    console.log(t('migrate.noFilesScanned.warning'));
    console.log(t(filesSkippedRuntime > 0
      ? 'migrate.noFilesScanned.becauseRuntime'
      : 'migrate.noFilesScanned.becauseEmpty', { count: filesSkippedRuntime }));
    return;
  }

  if (findings.length === 0) {
    console.log(t('migrate.clean'));
    if (!apply && filesSkippedRuntime > 0) {
      console.log('');
      console.log(runtimeSkipLine(t, filesSkippedRuntime));
    }
    return;
  }

  const counts = severityCounts(findings);
  console.log(t('migrate.counts', counts));
  console.log('');

  for (const f of findings) printFinding(t, f);

  const touchesOpus5 = findings.some((f) => f.idIssues.some((i) => i.replacement === 'claude-opus-5'));
  if (touchesOpus5) printOpus5Checklist(t);

  if (!apply) {
    if (filesSkippedRuntime > 0) console.log(runtimeSkipLine(t, filesSkippedRuntime));
    console.log(t('migrate.dryRunOnly'));
  }
}

function applyReplacements(t, findings, timestamp) {
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
    console.log(t('migrate.applied.file', { file: f.file, count: appliedCount, backup: dest }));
  }

  console.log('');
  console.log(t('migrate.applied.total', { files: filesChanged, replacements: replacementsMade }));
}

function main() {
  const argv = process.argv.slice(2);
  const { roots, apply, json, includeRuntime, configHint } = parseArgs(argv);

  // The language comes from the config being scanned, like audit.mjs: scanning
  // someone else's config reports it in that config's language.
  const { t } = createTranslator({
    explicit: flagValue(argv, '--lang'),
    configDir: resolveConfigDir(argv),
  });

  const { findings, filesScanned, filesSkippedRuntime } = scanRoots(roots, { includeRuntime, configHint, t });

  if (json) {
    console.log(JSON.stringify(
      { roots, filesScanned, filesSkippedRuntime, includeRuntime, apply, findings }, null, 2,
    ));
  } else {
    printReport(t, { roots, filesScanned, filesSkippedRuntime, findings, apply });
  }

  if (apply && findings.length > 0) {
    if (!json) console.log('');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    applyReplacements(t, findings, timestamp);
  }

  // A scan that read nothing proves nothing. Callers that drive this from a
  // script only ever see the exit code, so it has to be able to say "no
  // answer" as something other than "all clear".
  if (filesScanned === 0) process.exitCode = 2;
}

main();
