#!/usr/bin/env node
// run.mjs
// Runs every *.test.mjs in this directory and prints one summary.
//
//   node tests/run.mjs
//
// Plain Node, no dependencies, no install step. Each test builds its own
// fixtures in its own temporary directory and removes only what it created,
// so the suite touches no real Claude Code configuration and leaves nothing
// behind. Exits non-zero if any check failed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

const results = [];
for (const file of files) {
  console.log(`\n${'='.repeat(70)}\n${file}\n${'='.repeat(70)}`);
  const run = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  results.push({ file, code: run.status ?? 1 });
}

// The per-file counts are already on screen; this is the line a CI log gets
// read for, so it repeats the verdict rather than assuming anyone scrolled up.
const failedFiles = results.filter((r) => r.code !== 0);
console.log(`\n${'='.repeat(70)}`);
console.log(`SUMMARY: ${results.length - failedFiles.length}/${results.length} test file(s) passed`);
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.file}`);
console.log('='.repeat(70));

process.exit(failedFiles.length === 0 ? 0 : 1);
