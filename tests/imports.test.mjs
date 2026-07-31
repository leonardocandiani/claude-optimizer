// Regression tests for the @import graph. Node's built-in runner, no deps:
//   node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseImportPaths, resolveImports } from '../scripts/lib/imports.mjs';
import { measureConfig } from '../scripts/lib/audit-core.mjs';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('an @ inside a fenced block is an example, not an import', () => {
  const found = parseImportPaths('# t\n\n@real/file.md\n\n```\n@fake/file.md\n```\n');
  assert.deepEqual(found.map((f) => f.spec), ['real/file.md']);
});

test('an @ in inline code or an HTML comment is not an import', () => {
  const found = parseImportPaths('use `@inline/x.md` here\n<!-- @commented/y.md -->\n@real/z.md\n');
  assert.deepEqual(found.map((f) => f.spec), ['real/z.md']);
});

test('imported bytes land in the always-loaded total', () => {
  const body = 'x'.repeat(5000);
  const dir = fixture({ 'CLAUDE.md': '# c\n\n@context/big.md\n', 'context/big.md': body });
  const m = measureConfig(dir);
  assert.equal(m.importedBytes, body.length);
  assert.equal(m.alwaysLoadedBytes, m.claudeMdBytes + body.length);
});

test('an imported file is not double counted as a context card', () => {
  const dir = fixture({
    'CLAUDE.md': '# c\n\n@context/used.md\n',
    'context/used.md': 'a'.repeat(100),
    'context/unused.md': 'b'.repeat(200),
  });
  const m = measureConfig(dir);
  assert.equal(m.importedBytes, 100);
  assert.equal(m.contextCardsBytes, 200);
});

test('an import cycle terminates', () => {
  const dir = fixture({
    'CLAUDE.md': '# c\n\n@a.md\n', 'a.md': '@b.md\n', 'b.md': '@a.md\n',
  });
  const m = measureConfig(dir);
  assert.equal(m.imported.length, 2);
});

test('a broken import is reported, not counted', () => {
  const dir = fixture({ 'CLAUDE.md': '# c\n\n@gone.md\n' });
  const m = measureConfig(dir);
  assert.equal(m.brokenImports.length, 1);
  assert.equal(m.importedBytes, 0);
});

test('paths: on an imported file is flagged as ineffective', () => {
  const dir = fixture({
    'CLAUDE.md': '# c\n\n@context/x.md\n',
    'context/x.md': '---\npaths:\n  - "**/*.ts"\n---\n\nbody\n',
  });
  const m = measureConfig(dir);
  assert.equal(m.importedClaimingPaths.length, 1);
  // and it still counts as always loaded, because the gate does not apply
  assert.ok(m.importedBytes > 0);
});

test('a config with rules/ and no imports is unaffected', () => {
  const dir = fixture({
    'CLAUDE.md': '# c\n', 'rules/a.md': 'a'.repeat(300),
    'rules/b.md': '---\npaths:\n  - "**/*.ts"\n---\nb',
  });
  const m = measureConfig(dir);
  assert.equal(m.importedBytes, 0);
  assert.equal(m.brokenImports.length, 0);
  assert.equal(m.alwaysLoadedRulesBytes, 300);
});
