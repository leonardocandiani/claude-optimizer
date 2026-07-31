// topic-detector.test.mjs
// The heuristic that says "this file is about one topic" has to tell a rule
// that USES a topic apart from a rule that QUOTES it as the mistake to avoid.
//
// Born from a real false positive on a real config: a live safety rule that
// forbids killing processes by generic name was flagged as "Python content, 13
// keyword hits" because it spells the anti-pattern out as `coletor.py`,
// `main.py` and `python`. The report then told the user to unload it. Acting on
// that advice would have switched off an active protection while the byte count
// improved.
//
// Both halves are tested: the false positive must not come back (fixture below
// mirrors the real rule), and the detector must still catch a rule that really
// is about one file type (positive control -- without it, "detects nothing"
// would pass this file).

import { createSuite, scratchDir, auditJson, runScript } from './lib/harness.mjs';
import { contentForTopicDetection } from '../scripts/lib/audit-core.mjs';

const s = createSuite('topic-detector');
const tmp = scratchDir('topic');

// A safety rule that quotes Python file names as the thing NOT to do.
const SAFETY_RULE = [
  '# Watchdog that kills by generic name takes down OTHER projects',
  '',
  'This machine runs several projects at once. Killing a process by a generic',
  'name takes down the neighbour project in silence. It has happened twice.',
  '',
  '## The rule',
  '',
  '1. Whoever BUILDS a watchdog or auto-restarter:',
  '   NUNCA match or kill a process by a generic script name (`*coletor.py*`,',
  '   `*main.py*`, `*run.py*`, `*app.py*`, `*bot.py*`). That filter matches the',
  '   script of ANY project with the same file name. Identify only your own',
  '   process by PID file, by a unique command signature, or by full path.',
  '',
  '2. Whoever NAMES a long scheduled script: assume you are not the only',
  '   `coletor.py` on the machine. Use a unique name per project',
  '   (`coletor_fretebras.py`, `coletor_radar.py`).',
  '',
  '## Also true for generic PROCESS names',
  '',
  'Exemplo real: a memory guard killed the debug Chrome while pruning `chrome`.',
  'Anti-padrao: killing by broad Name (`chrome`, `python`, `node`).',
  '',
].join('\n');

// A rule that genuinely is about running Python in this project. No negation
// markers, no anti-pattern quoting: every mention is the rule using the topic.
const REAL_PYTHON_RULE = [
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
  s.heading('The filter drops code spans and example/negation lines');
  {
    const filtered = contentForTopicDetection(SAFETY_RULE);
    const hits = (filtered.match(/\bpython\b|\.py\b/gi) ?? []).length;
    const raw = (SAFETY_RULE.match(/\bpython\b|\.py\b/gi) ?? []).length;
    s.ok(raw >= 8, `the raw text really does look Python-heavy (${raw} hits)`);
    s.equal(hits, 0, 'after filtering, nothing is left to mistake for a Python rule');
  }

  s.heading('A safety rule quoting .py names is NOT proposed for removal');
  {
    const dir = tmp.mkdir('safety');
    tmp.write('safety/CLAUDE.md', 'root\n@context/watchdog.md\n');
    tmp.write('safety/context/watchdog.md', SAFETY_RULE);

    const j = auditJson(dir);
    s.equal(j.budget.importedCount, 1, 'the rule is measured as always loaded');
    s.equal(j.importDemotionCandidates.length, 0, 'and it is not listed as a candidate to unload');
  }

  s.heading('A rule that really is about one file type is still caught');
  {
    const dir = tmp.mkdir('python');
    tmp.write('python/CLAUDE.md', 'root of the config\n');
    tmp.write('python/rules/python.md', REAL_PYTHON_RULE);

    const j = auditJson(dir);
    s.equal(j.conditionalRuleCandidates.length, 1, 'one conditional-rule candidate');
    s.equal(j.conditionalRuleCandidates[0]?.category, 'Python', 'classified as Python');
    s.ok(
      (j.conditionalRuleCandidates[0]?.suggestedPaths ?? []).includes('**/*.py'),
      'with a usable glob suggestion',
    );
  }

  s.heading('The report proposes, it does not order');
  {
    const dir = tmp.mkdir('wording');
    tmp.write('wording/CLAUDE.md', 'root\n@python-guide.md\n');
    tmp.write('wording/python-guide.md', REAL_PYTHON_RULE);

    const j = auditJson(dir);
    s.equal(j.importDemotionCandidates.length, 1, 'the imported single-topic file is flagged');

    const text = runScript('audit.mjs', ['--dir', dir, '--lang', 'en']);
    s.ok(/CANDIDATE/.test(text), 'the line calls it a candidate');
    s.ok(/needs human review/i.test(text), 'the section header asks for human review');
    s.ok(/Heuristic, not a verdict/.test(text), 'the caution note is printed');
    s.ok(!/->\s*remove the @import line/i.test(text), 'no bare order to remove the import');
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
