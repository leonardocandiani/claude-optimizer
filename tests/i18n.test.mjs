// i18n.test.mjs
// The README promises the report speaks the user's language. audit.mjs used to
// have its strings hardcoded in English, so for a Portuguese-speaking user the
// promise was false and the most detailed report in the project was unreadable.
//
// Two failure modes are guarded here, and the second is the sneaky one:
//   1. a key used by the code that exists in no locale file -- the translator
//      falls back to printing the raw key, which looks like a bug in the tool;
//   2. a locale that silently lost a key. Missing keys fall back to English, so
//      nothing crashes and nobody notices: half a report in the wrong language.

import fs from 'node:fs';
import path from 'node:path';
import { createSuite, scratchDir, runScript, PROJECT_ROOT } from './lib/harness.mjs';

const s = createSuite('i18n');
const tmp = scratchDir('i18n');

const LOCALES_DIR = path.join(PROJECT_ROOT, 'locales');
const readLocale = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));

try {
  const en = readLocale('en');
  const shipped = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

  s.heading('The three shipped locales are present and parse');
  for (const code of ['en', 'pt', 'es']) {
    s.ok(shipped.includes(code), `locales/${code}.json ships`);
  }

  // Checked per script, not once over the whole scripts/ folder: the failure
  // this catches is a script that prints without asking the translator at all,
  // and a folder-wide grep would hide that behind whichever script does ask.
  // migrate-models.mjs was exactly that case -- ~30 English literals, zero t()
  // calls -- and it is the half of the tool that offers to write into the
  // user's own config, so its risk warnings were unreadable to the owner.
  s.heading('Every reporting script goes through the translator');
  for (const script of ['audit.mjs', 'migrate-models.mjs']) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', script), 'utf8');
    const used = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
    const missing = [...new Set(used)].filter((k) => en[k] === undefined);
    s.ok(used.length > 15, `${script} goes through the translator (${used.length} calls)`);
    s.equal(missing.length, 0, `${script}: no key falls through to its own name${missing.length ? `: ${missing.join(', ')}` : ''}`);

    // A literal that never reaches t() is invisible to the check above: the
    // key count stays healthy while the line prints in English regardless of
    // --lang. Catch the shape that produced the bug -- a sentence handed
    // straight to console.log.
    const rawSentences = [...source.matchAll(/console\.(log|error)\(\s*(['"])([^'"]{25,})\2\s*\)/g)]
      .map((m) => m[3])
      .filter((text) => /[a-z]{3}\s+[a-z]{3}/i.test(text)); // prose, not a separator or a path
    s.equal(rawSentences.length, 0,
      `${script}: no untranslated sentence goes straight to the console${rawSentences.length ? `: "${rawSentences[0].slice(0, 60)}"` : ''}`);
  }

  s.heading('Every breaking-change hint has a key in English');
  {
    const { BREAKING_HINT_KEYS } = await import(
      new URL('../scripts/lib/model-ids.mjs', import.meta.url).href
    );
    const missing = BREAKING_HINT_KEYS.filter((k) => en[k] === undefined);
    s.ok(BREAKING_HINT_KEYS.length > 0, `the hints carry translation keys (${BREAKING_HINT_KEYS.length})`);
    s.equal(missing.length, 0, `every hint key exists${missing.length ? `: ${missing.join(', ')}` : ''}`);
  }

  s.heading('pt and es carry every English key');
  for (const code of ['pt', 'es']) {
    const loc = readLocale(code);
    const missing = Object.keys(en).filter((k) => loc[k] === undefined);
    s.equal(missing.length, 0, `${code}.json is complete${missing.length ? `, missing: ${missing.slice(0, 5).join(', ')}` : ''}`);
    const untouched = Object.keys(en).filter((k) => loc[k] === en[k] && en[k].length > 25);
    s.ok(untouched.length <= 2, `${code}.json is actually translated (${untouched.length} long string(s) left in English)`);
  }

  s.heading('Placeholders survive translation');
  {
    const placeholders = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const code of ['pt', 'es']) {
      const loc = readLocale(code);
      const broken = Object.keys(en).filter((k) => loc[k] !== undefined && placeholders(loc[k]) !== placeholders(en[k]));
      s.equal(broken.length, 0, `${code}.json keeps the same {placeholders}${broken.length ? `: ${broken.slice(0, 5).join(', ')}` : ''}`);
    }
  }

  s.heading('The report really comes out in the chosen language');
  {
    const dir = tmp.mkdir('config');
    tmp.write('config/CLAUDE.md', 'root\n@regra.md\n');
    // Big enough that a locale-grouped number would look different
    // (12.345 / 12,345 / 12345), which is the point of the last check below.
    tmp.write('config/regra.md', 'conteudo da regra. '.repeat(700));

    const enOut = runScript('audit.mjs', ['--dir', dir, '--lang', 'en']);
    const ptOut = runScript('audit.mjs', ['--dir', dir, '--lang', 'pt']);
    const esOut = runScript('audit.mjs', ['--dir', dir, '--lang', 'es']);

    s.ok(/CONTEXT BUDGET/.test(enOut), 'en prints the English heading');
    s.ok(/ORÇAMENTO DE CONTEXTO/.test(ptOut), 'pt prints the Portuguese heading');
    s.ok(/PRESUPUESTO DE CONTEXTO/.test(esOut), 'es prints the Spanish heading');
    s.ok(!/CONTEXT BUDGET/.test(ptOut), 'pt does not leak the English heading');

    // The half of the tool that offers to write into the user's config has to
    // speak the same language as the half that only reads. Checked on the
    // lines that carry the risk: the mode, the invitation to --apply, and the
    // API hints -- those are the ones the owner has to understand to consent.
    s.heading('The migration scan speaks the chosen language too');
    {
      const proj = tmp.mkdir('projeto');
      tmp.write('projeto/agente.py',
        'import anthropic\nmodel="claude-3-opus-20240229"\ntemperature=0.7\nthinking={"budget_tokens": 2048}\n');

      const mEn = runScript('migrate-models.mjs', ['--dir', proj, '--lang', 'en']);
      const mPt = runScript('migrate-models.mjs', ['--dir', proj, '--lang', 'pt']);
      const mEs = runScript('migrate-models.mjs', ['--dir', proj, '--lang', 'es']);

      s.ok(/Mode: dry-run/.test(mEn), 'en prints the English mode line');
      s.ok(/Modo: simulação/.test(mPt), 'pt prints the Portuguese mode line');
      s.ok(/Modo: simulación/.test(mEs), 'es prints the Spanish mode line');
      s.ok(!/dry-run \(no changes written\)/.test(mPt), 'pt does not leak the English mode line');
      s.ok(/--apply/.test(mPt) && /Só simulação/.test(mPt), 'pt explains the --apply invitation in Portuguese');
      s.ok(/CONFERIR A API/.test(mPt), 'pt translates the API breaking-change hint');
      s.ok(/recusado com erro 400/.test(mPt), 'and the hint text itself, not just its label');
      s.ok(/APOSENTADO \(404\)/.test(mPt), 'pt translates the severity tag');
      // The translator substitutes {word} patterns, and the advice it has to
      // print contains literal braces. If it ever starts matching them, the
      // fix it recommends comes out mangled in every language.
      for (const [code, out] of [['en', mEn], ['pt', mPt], ['es', mEs]]) {
        s.ok(out.includes('thinking: {type: "adaptive"}'),
          `${code} keeps the code snippet intact instead of eating it as a {placeholder}`);
      }
    }

    s.heading('The environment variable selects the language too');
    const envOut = runScript('audit.mjs', ['--dir', dir], { env: { CLAUDE_OPTIMIZER_LANG: 'pt' } });
    s.ok(/ORÇAMENTO DE CONTEXTO/.test(envOut), 'CLAUDE_OPTIMIZER_LANG=pt is honoured');

    s.heading('The audited settings.json decides when nothing else does');
    tmp.write('config/settings.json', `{"language": "Portuguese"}\n`);
    const settingsOut = runScript('audit.mjs', ['--dir', dir]);
    s.ok(/ORÇAMENTO DE CONTEXTO/.test(settingsOut), 'language: Portuguese in settings.json is honoured');

    s.heading('English is the fallback when no language is configured anywhere');
    fs.rmSync(tmp.join('config/settings.json'));
    const fallback = runScript('audit.mjs', ['--dir', dir]);
    s.ok(/CONTEXT BUDGET/.test(fallback), 'falls back to English');

    // An audit figure gets pasted into issues and commit messages, so it is
    // printed as raw digits on purpose: "13.316" and "13,316" are the same
    // number to a machine and two different ones to a person in another locale.
    s.heading('Numbers stay machine-readable in every language');
    {
      const total = JSON.parse(runScript('audit.mjs', ['--dir', dir, '--json'])).budget.alwaysLoadedBytes;
      s.ok(total > 9999, `the fixture is big enough for grouping to show (${total} bytes)`);
      const grouped = total.toLocaleString('pt-BR');
      for (const [code, out] of [['en', enOut], ['pt', ptOut], ['es', esOut]]) {
        s.ok(out.includes(String(total)), `${code} prints ${total} verbatim`);
        s.ok(!out.includes(grouped), `${code} does not print the grouped form ${grouped}`);
      }
    }
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
