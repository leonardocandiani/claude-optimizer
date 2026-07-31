// apply-safety.test.mjs
// apply.mjs may only make changes that cannot lose information or quietly
// change behaviour. The case with teeth: writing a `paths:` block into a file
// that CLAUDE.md pulls in with @. It would look like a saving, load exactly the
// same bytes on every session, and -- worst of all -- make the next audit
// reclassify the file as conditional and drop it from the budget. The tool
// would report a win while re-creating the under-reporting it exists to fix.
//
// Both halves are checked. Refusing to write is only correct if writing still
// happens where it is safe, so the same rule content is tested twice: once
// imported (must be left alone) and once not (must be corrected).

import fs from 'node:fs';
import { createSuite, scratchDir, runScript, auditJson } from './lib/harness.mjs';

const s = createSuite('apply-safety');
const tmp = scratchDir('apply');

// Single-topic on purpose, so the C3 heuristic really does flag it. No negation
// or example markers: this rule USES Python, it does not quote it.
const PYTHON_RULE = [
  '# Como rodar os scripts python deste projeto',
  '',
  'Todo script python vive na pasta de scripts e roda com python -X dev.',
  'O python do projeto e o do venv, criado com python -m venv .venv.',
  'Formatar python com black antes de subir. Instalar com python -m pip.',
  'O arquivo principal e app_projeto.py e o auxiliar util_projeto.py.',
  'Cada modulo python novo entra no pacote python do repositorio.',
  '',
].join('\n');

try {
  s.heading('An imported rule is never given a paths: block');
  {
    const dir = tmp.mkdir('imported');
    tmp.write('imported/CLAUDE.md', 'root\n@rules/python.md\n');
    tmp.write('imported/rules/python.md', PYTHON_RULE);

    const before = tmp.read('imported/rules/python.md');
    runScript('apply.mjs', ['--dir', dir, '--conditional-frontmatter', '--skip-migrate-models', '--apply']);
    const after = tmp.read('imported/rules/python.md');

    s.equal(after, before, 'the file is byte-identical after --apply');
    s.ok(!after.startsWith('---'), 'no frontmatter was written into it');
    s.ok(!fs.existsSync(tmp.join('imported/_archive')), 'nothing was even backed up, because nothing was touched');

    const j = auditJson(dir);
    s.equal(j.budget.conditionalBytes, 0, 'and the audit still counts it as always loaded');
  }

  s.heading('Positive control: the same rule, NOT imported, is corrected');
  {
    const dir = tmp.mkdir('not-imported');
    tmp.write('not-imported/CLAUDE.md', 'root of the config, importing nothing\n');
    tmp.write('not-imported/rules/python.md', PYTHON_RULE);

    const plan = runScript('apply.mjs', ['--dir', dir, '--conditional-frontmatter', '--skip-migrate-models']);
    s.ok(/conditional-frontmatter/.test(plan), 'the dry-run plans the correction');

    runScript('apply.mjs', ['--dir', dir, '--conditional-frontmatter', '--skip-migrate-models', '--apply']);
    const after = tmp.read('not-imported/rules/python.md');
    s.ok(after.startsWith('---\npaths:'), 'the paths: block was written');
    s.ok(after.includes(PYTHON_RULE), 'the original content is intact underneath');
    s.ok(fs.existsSync(tmp.join('not-imported/_archive')), 'the pre-change file was backed up first');
  }

  s.heading('Dry-run is the default: nothing is written without --apply');
  {
    const dir = tmp.mkdir('dry');
    tmp.write('dry/CLAUDE.md', 'root of the config\n');
    tmp.write('dry/rules/python.md', PYTHON_RULE);

    runScript('apply.mjs', ['--dir', dir, '--conditional-frontmatter', '--skip-migrate-models']);
    s.equal(tmp.read('dry/rules/python.md'), PYTHON_RULE, 'the rule is untouched');
    s.ok(!fs.existsSync(tmp.join('dry/_archive')), 'no backup folder was created');
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
