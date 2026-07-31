// legacy-format.test.mjs
// The classic config shape -- CLAUDE.md + rules/ + references/, no @import
// anywhere -- must measure exactly what it measured before imports were
// understood at all. Every byte here is asserted against the length of the
// fixture the test itself just wrote, so the expected values are derived from
// the fixture rather than copied from a run that happened to look right.

import { createSuite, scratchDir, auditJson, bytes } from './lib/harness.mjs';

const s = createSuite('legacy-format');
const tmp = scratchDir('legacy');

const CLAUDE_MD = [
  '# Project config',
  '',
  'Commit in Portuguese. Ask before deleting anything.',
  'Detail lives in references/estilo-completo.md, open it when writing copy.',
  '',
].join('\n');

const RULE_ALWAYS = [
  '# How we work',
  '',
  'Explain the plan before running it. Never report done without checking.',
  '',
].join('\n');

const RULE_CONDITIONAL = [
  '---',
  'paths:',
  '  - "**/*.zzz"',
  '---',
  '',
  '# Only for zzz files',
  '',
  'Loads when a .zzz file is in play, and not otherwise.',
  '',
].join('\n');

const REFERENCE = '# Full style catalogue\n\nEvery case, every quote, read on demand.\n';

try {
  const dir = tmp.mkdir('config');
  tmp.write('config/CLAUDE.md', CLAUDE_MD);
  tmp.write('config/rules/trabalho.md', RULE_ALWAYS);
  tmp.write('config/rules/zzz.md', RULE_CONDITIONAL);
  tmp.write('config/references/estilo-completo.md', REFERENCE);
  tmp.mkdir('config/skills/alguma-skill');

  const j = auditJson(dir);
  const b = j.budget;

  s.heading('Budget of a rules/ + references/ config');
  s.equal(b.claudeMdBytes, bytes(CLAUDE_MD), 'CLAUDE.md bytes');
  s.equal(b.alwaysLoadedRulesBytes, bytes(RULE_ALWAYS), 'always-loaded rule bytes');
  s.equal(b.alwaysLoadedRulesCount, 1, 'one always-loaded rule');
  s.equal(b.alwaysLoadedBytes, bytes(CLAUDE_MD) + bytes(RULE_ALWAYS), 'always-loaded total');
  s.equal(b.conditionalBytes, bytes(RULE_CONDITIONAL), 'conditional rule bytes');
  s.equal(b.conditionalRulesCount, 1, 'one conditional rule');
  s.equal(b.referencesBytes, bytes(REFERENCE), 'reference bytes');
  s.equal(b.referencesCount, 1, 'one reference file');
  s.equal(b.skillsCount, 1, 'one skill directory');

  s.heading('Nothing from the import machinery leaks into a config with no imports');
  s.equal(b.importedBytes, 0, 'no imported bytes');
  s.equal(b.importedCount, 0, 'no imported documents');
  s.equal(b.brokenImportsCount, 0, 'no broken imports');
  s.equal(b.importsIgnoringPathsCount, 0, 'no ignored paths: declarations');
  s.equal(b.importedConditionalBytes, 0, 'imported-conditional bucket is structurally empty');
  s.equal(b.importedConditionalCount, 0, 'imported-conditional count is structurally empty');

  s.heading('The other capabilities behave as before');
  s.equal(j.deadPointers.length, 0, 'the reference cited in CLAUDE.md resolves');
  s.equal(j.threeLayerArchitecture.rulesDir, true, 'rules/ detected');
  s.equal(j.threeLayerArchitecture.referencesDir, true, 'references/ detected');
  s.equal(j.threeLayerArchitecture.importLayer, false, 'no import layer claimed');
  s.equal(j.alwaysLoadedDocs.length, 2, 'inventory lists CLAUDE.md and the one always-loaded rule');

  s.heading('A pointer to a file that does not exist is still caught');
  {
    const dir2 = tmp.mkdir('broken-pointer');
    tmp.write('broken-pointer/CLAUDE.md', 'Read references/nao-existe.md before deploying.\n');
    const k = auditJson(dir2);
    s.equal(k.deadPointers.length, 1, 'one dead pointer');
    s.equal(k.deadPointers[0].target, 'references/nao-existe.md', 'and it names the path');
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
