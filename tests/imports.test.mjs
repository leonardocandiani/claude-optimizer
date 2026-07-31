// imports.test.mjs
// What @import really costs, and what is not an import at all.
//
// Descends from a throwaway battery written while the import support was being
// built. Rewritten to build its own fixtures at run time, so it survives the
// scratch folder it was born in being deleted.

import { createSuite, scratchDir, auditJson, bytes } from './lib/harness.mjs';
import { measureConfig } from '../scripts/lib/audit-core.mjs';

const s = createSuite('imports');
const tmp = scratchDir('imports');

try {
  // --- prose that mentions @ is not an import ------------------------------
  // The regression that matters most: a config explaining the import mechanism
  // in words, or naming a scoped package or a handle, must not turn those
  // tokens into imports. Getting this wrong invents broken imports the user
  // cannot fix, because the file never existed.
  s.heading('An @ in prose is not an import');
  {
    const dir = tmp.mkdir('prose');
    tmp.write('prose/CLAUDE.md', [
      '# Config',
      '',
      'Rules are pulled in with an @import line, which is how this file grows.',
      'We install @tanstack/react-query and ping @robson when it breaks.',
      'Mail goes to someone@example.com and we pin the package@latest.',
      '',
      '@real-rule.md',
      '',
      'A fenced example must not count either:',
      '',
      '```',
      '@fenced-example.md',
      '```',
      '',
      'And neither must an inline one: `@inline-example.md`.',
      '',
    ].join('\n'));
    tmp.write('prose/real-rule.md', 'The only file that really loads.\n');

    const j = auditJson(dir);
    s.equal(j.budget.importedCount, 1, 'exactly one real import is counted');
    s.equal(j.importedDocs[0].file, '@real-rule.md', 'and it is the one written as a bare @ line');
    s.equal(j.budget.brokenImportsCount, 0, 'no phantom broken imports from prose, fences or inline code');
  }

  // --- a cycle terminates ---------------------------------------------------
  s.heading('A -> B -> A terminates and each file is paid for once');
  {
    const dir = tmp.mkdir('cycle');
    tmp.write('cycle/CLAUDE.md', 'root\n@a.md\n');
    tmp.write('cycle/a.md', 'a\n@b.md\n');
    tmp.write('cycle/b.md', 'b\n@a.md\n');

    const j = auditJson(dir);
    s.equal(j.budget.importedCount, 2, 'two documents, no infinite loop');
    s.equal(j.budget.brokenImportsCount, 0, 'the cycle is cut silently, not reported as broken');
  }

  // --- a broken import is reported, and only once ---------------------------
  s.heading('A broken @import is reported as such, never as a dead pointer');
  {
    const dir = tmp.mkdir('broken');
    tmp.write('broken/CLAUDE.md', 'root\n@ghost.md\n@there.md\n@image.png\n');
    tmp.write('broken/there.md', 'this one exists\n');
    tmp.write('broken/image.png', 'not really a png, but the extension decides\n');

    const j = auditJson(dir);
    s.equal(j.budget.brokenImportsCount, 2, 'the missing file and the non-inlineable one are both reported');
    s.equal(j.budget.importedCount, 1, 'the import that does resolve is still counted');
    s.equal(j.deadPointers.length, 0, 'a broken import does not leak into the dead-pointer list');
    const reasons = j.brokenImports.map((b) => b.reason).sort();
    s.ok(reasons.join(',') === 'non-text,not-found', `reasons are distinguished (${reasons.join(',')})`);
  }

  // --- an imported file is always loaded, paths: or not ---------------------
  // Settled by controlled experiment on Claude Code v2.1.220: `paths:` gates a
  // file in rules/ and is ignored on a file arriving by @import. The branch
  // that used to zero such a file reported a saving that did not exist, which
  // is the worst failure mode available: it looks like good news.
  s.heading('paths: in an imported file is ignored, so the file costs full price');
  {
    const dir = tmp.mkdir('ignored-paths');
    const body = '---\npaths:\n  - "**/*.zzz"\n---\n\n' + 'Rule body that loads on every session.\n';
    tmp.write('ignored-paths/CLAUDE.md', 'root\n@gated.md\n');
    tmp.write('ignored-paths/gated.md', body);

    const j = auditJson(dir);
    const claudeMd = bytes('root\n@gated.md\n');
    s.equal(j.budget.importedCount, 1, 'the file is counted as an imported document');
    s.equal(j.budget.importedBytes, bytes(body), 'its full byte count enters the budget');
    s.equal(j.budget.alwaysLoadedBytes, claudeMd + bytes(body), 'always-loaded total includes it');
    s.equal(j.budget.conditionalBytes, 0, 'nothing is filed as conditional');
    s.equal(j.budget.importsIgnoringPathsCount, 1, 'and the user is warned the paths: does nothing');
    s.equal(j.importsIgnoringPaths[0].file, '@gated.md', 'the warning names the file');
  }

  // --- same trap through rules/ ---------------------------------------------
  s.heading('A rules/ file that is ALSO imported loses its gate too');
  {
    const dir = tmp.mkdir('rule-imported');
    const body = '---\npaths:\n  - "**/*.zzz"\n---\n\nGated in theory, inlined in practice.\n';
    tmp.write('rule-imported/CLAUDE.md', 'root\n@rules/gated.md\n');
    tmp.write('rule-imported/rules/gated.md', body);

    const j = auditJson(dir);
    s.equal(j.budget.conditionalBytes, 0, 'it is not counted as conditional');
    s.equal(j.budget.alwaysLoadedRulesBytes, bytes(body), 'its bytes land in the always-loaded rules total');
    s.equal(j.budget.importsIgnoringPathsCount, 1, 'and it is reported as an ignored paths: declaration');
  }

  // --- positive control: gating still works where it belongs ----------------
  s.heading('A rules/ file with paths: and NO import is still conditional');
  {
    const dir = tmp.mkdir('real-gate');
    const body = '---\npaths:\n  - "**/*.zzz"\n---\n\nOnly loads when a .zzz file is in play.\n';
    tmp.write('real-gate/CLAUDE.md', 'root, importing nothing\n');
    tmp.write('real-gate/rules/gated.md', body);

    const j = auditJson(dir);
    s.equal(j.budget.conditionalBytes, bytes(body), 'the gate is respected under rules/');
    s.equal(j.budget.alwaysLoadedRulesBytes, 0, 'and it stays out of the always-loaded budget');
    s.equal(j.budget.importsIgnoringPathsCount, 0, 'no warning: this one really is conditional');
  }

  // --- the inventory adds up ------------------------------------------------
  s.heading('The always-loaded inventory accounts for every byte of the total');
  {
    const dir = tmp.mkdir('inventory');
    tmp.write('inventory/CLAUDE.md', 'root\n@one.md\n@two.md\n');
    tmp.write('inventory/one.md', 'x'.repeat(300) + '\n');
    tmp.write('inventory/two.md', 'y'.repeat(120) + '\n');

    const j = auditJson(dir);
    const sum = j.alwaysLoadedDocs.reduce((acc, d) => acc + d.bytes, 0);
    s.equal(sum, j.budget.alwaysLoadedBytes, 'rows sum to alwaysLoadedBytes');
    s.equal(j.alwaysLoadedDocs.length, 3, 'CLAUDE.md and both imports are listed');
    s.ok(j.alwaysLoadedDocs[0].bytes >= j.alwaysLoadedDocs[1].bytes, 'sorted largest first');
    const share = j.alwaysLoadedDocs.reduce((acc, d) => acc + d.percent, 0);
    s.ok(Math.abs(share - 100) < 0.5, `shares add up to ~100% (${share.toFixed(1)}%)`);
  }

  // --- measurement must not depend on the order of the @ lines --------------
  // A depth-first walk sharing one visited set could stamp a file at depth 4,
  // decline to descend, and then discard it when it turned up as a direct
  // import. Swapping two lines in CLAUDE.md changed the reported total.
  s.heading('The same graph measures the same in either line order');
  {
    const build = (label, root) => {
      const dir = tmp.mkdir(`order-${label}`);
      tmp.write(`order-${label}/CLAUDE.md`, root);
      tmp.write(`order-${label}/c1.md`, 'c1\n@c2.md\n');
      tmp.write(`order-${label}/c2.md`, 'c2\n@c3.md\n');
      tmp.write(`order-${label}/c3.md`, 'c3\n@x.md\n');
      tmp.write(`order-${label}/x.md`, 'x\n@child-of-x.md\n');
      tmp.write(`order-${label}/child-of-x.md`, 'CHILD '.repeat(200) + '\n');
      return measureConfig(dir);
    };
    const a = build('a', 'root\n@c1.md\n@x.md\n'); // long chain first
    const b = build('b', 'root\n@x.md\n@c1.md\n'); // shallow shortcut first
    const names = (m) => m.importedDocs.map((d) => `${d.rel}(d${d.depth})`).sort().join(' ');

    s.ok(a.importedDocs.some((d) => d.rel === 'child-of-x.md'), 'the grandchild is counted in order A');
    s.ok(b.importedDocs.some((d) => d.rel === 'child-of-x.md'), 'the grandchild is counted in order B');
    s.equal(a.alwaysLoadedBytes, b.alwaysLoadedBytes, 'both orders report the same bytes');
    s.equal(names(a), names(b), 'both orders discover the same files at the same depths');
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
