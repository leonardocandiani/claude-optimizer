// distillation.test.mjs
// Guards the distillation safety net. The failure this fixes is silent by
// construction -- a fact moved nowhere leaves no error, just a smaller file --
// so the detector has to be tested in BOTH directions: it must fire when a
// fact is dropped, and it must stay quiet when the fact merely moved.
//
// The "stays quiet" half is the one that rots. A detector that got too strict
// gets muted by whoever hits the false alarms, and then it protects nothing.

import { createSuite } from './lib/harness.mjs';
import { extractAtoms, findOrphans } from '../scripts/verify-distillation.mjs';

const t = createSuite('distillation');

const ORIGINAL = `
# Contas

O orgId da conta pessoal é \`team_ARc8Xl1yZ4MVpJPxkSeePkvN\`.
Trocar de conta: \`gh auth switch -u <conta>\`.
O vigia é o \`hooks/gh-conta-pessoal-context.js\`.
Login: robson.silveira@segsmart.com.br
A variável GH_CONFIG_DIR aponta pra gaveta.
Rodar com --include-runtime pra varrer tudo.

Este parágrafo é prosa comum que vai ser reescrita durante a destilação,
e reescrever prosa é exatamente o objetivo, então NUNCA deve virar alarme.
Existem DUAS contas e três casos ESPECÍFICOS a considerar.
`;

t.heading('atoms: identifiers are protected, emphasis is not');
{
  const atoms = [...extractAtoms(ORIGINAL).values()].map((a) => a.atom);

  t.ok(atoms.includes('team_ARc8Xl1yZ4MVpJPxkSeePkvN'), 'org id is an atom');
  t.ok(atoms.includes('gh auth switch -u <conta>'), 'command in backticks is an atom');
  t.ok(atoms.includes('hooks/gh-conta-pessoal-context.js'), 'path is an atom');
  t.ok(atoms.includes('robson.silveira@segsmart.com.br'), 'email is an atom');
  t.ok(atoms.includes('GH_CONFIG_DIR'), 'env var is an atom');
  t.ok(atoms.includes('--include-runtime'), 'flag is an atom');

  // Portuguese rules lean on ALL-CAPS for emphasis. Treating that as a
  // protected identifier buries the real orphans in noise.
  t.ok(!atoms.includes('DUAS'), 'ALL-CAPS emphasis is not an atom');
  t.ok(!atoms.includes('NUNCA'), 'ALL-CAPS emphasis is not an atom');
  // An accent must not slice a word: without accented capitals in the run,
  // "ESPECÍFICOS" would report as the meaningless fragment "FICOS".
  t.ok(!atoms.includes('FICOS'), 'accent does not slice a word into a fragment');
}

t.heading('orphans: fires when a fact lands nowhere');
{
  // The distilled rule mentions the hook by bare name and refers to switching
  // accounts without giving the command. Both READ as if the fact survived,
  // which is exactly why a human re-reading the text misses them.
  const distilled = `
    # Contas
    Trocar de conta em Proteauto: aí sim pode trocar.
    O vigia é o \`gh-conta-pessoal-context.js\`.
    Login: robson.silveira@segsmart.com.br
  `;
  const orphans = findOrphans(ORIGINAL, [distilled]).map((o) => o.atom);

  t.ok(orphans.includes('team_ARc8Xl1yZ4MVpJPxkSeePkvN'), 'dropped org id is caught');
  t.ok(orphans.includes('gh auth switch -u <conta>'), 'dropped command is caught');
  t.ok(orphans.includes('hooks/gh-conta-pessoal-context.js'), 'bare filename does not cover the path');
  t.ok(!orphans.includes('robson.silveira@segsmart.com.br'), 'kept email is not an orphan');
}

t.heading('orphans: stays quiet when the fact merely moved');
{
  const distilled = `
    # Contas
    Login: robson.silveira@segsmart.com.br
    Detalhe e receitas: ver o arquivo de histórico.
  `;
  const destination = `
    # Histórico
    orgId pessoal: \`team_ARc8Xl1yZ4MVpJPxkSeePkvN\`
    Trocar: \`gh auth switch -u <conta>\`
    Vigia: \`hooks/gh-conta-pessoal-context.js\`
    Variável GH_CONFIG_DIR na gaveta. Flag --include-runtime.
  `;
  t.equal(findOrphans(ORIGINAL, [distilled, destination]).length, 0,
          'nothing is orphaned when every atom exists in some destination');
}

t.heading('orphans: reformatting a fact is not losing it');
{
  // A fact moved into a table cell is still the fact. Comparison normalizes
  // whitespace and case so layout changes do not raise false alarms.
  const destination = 'orgId  |  TEAM_ARC8XL1YZ4MVPJPXKSEEPKVN  | pessoal';
  t.equal(findOrphans('`team_ARc8Xl1yZ4MVpJPxkSeePkvN`', [destination]).length, 0,
          'case and spacing changes are not losses');
}

const { failed } = t.finish();
process.exit(failed > 0 ? 1 : 0);
