#!/usr/bin/env node
// verify-distillation.mjs
// The safety net for the distillation pass: proves that nothing evaporated.
//
// The SKILL.md procedure says "move the original, do not delete it", and when
// the whole file moves to references/ that is trivially safe. The dangerous
// case is the one a mature config actually hits: a rule that ALREADY has a
// companion reference file, where distilling means moving PIECES into a file
// that already exists. Every piece that lands nowhere is a fact deleted, and
// it disappears silently -- the byte count improves, the report says the diet
// worked, and the loss only surfaces months later when someone needs the fact
// and it is in no file at all.
//
// So this compares the BEFORE text against the AFTER text plus every file the
// content was moved INTO, and reports the high-value atoms (identifiers,
// paths, commands, emails, URLs, flags) that exist in the before and in none
// of the after. Prose is deliberately out of scope: rewording a sentence is
// the whole point of distilling, and flagging it would bury the real losses.
//
// Usage:
//   node scripts/verify-distillation.mjs --before <original> --after <distilled> \
//        [--into <destination>]... [--json]
//
// Exit 0 when nothing was lost, 2 when at least one atom is orphaned. The
// non-zero exit is what lets this run in a pre-commit hook or a test.

import fs from 'node:fs';
import { flagValue } from './lib/config-dir.mjs';

// Atoms are things a human cannot re-derive from memory: an org id, a CLI
// flag, a file path, a config key. Each pattern is deliberately narrow --
// a false orphan costs the user a manual check, but a missed one costs a fact.
const ATOM_PATTERNS = [
  { key: 'code', re: /`([^`\n]{2,80})`/g, pick: (m) => m[1] },          // `git config user.email`
  { key: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, pick: (m) => m[0] },
  { key: 'url', re: /\bhttps?:\/\/[^\s)>\]"']+/g, pick: (m) => m[0] },
  { key: 'winpath', re: /\b[A-Za-z]:\\[^\s`"'|)]+/g, pick: (m) => m[0] },
  { key: 'path', re: /\b[\w.-]+\/[\w./-]{2,}\.\w{1,5}\b/g, pick: (m) => m[0] },
  // team_ARc8Xl1yZ4MVpJPxkSeePkvN, GH_CONFIG_DIR, CLAUDE_CODE_MAX_...: a token
  // carrying an underscore or a long digit/case mix is an identifier, not prose.
  { key: 'ident', re: /\b[A-Za-z][\w-]*_[\w-]{2,}\b/g, pick: (m) => m[0] },
  // An ALL-CAPS run only counts as a constant when it carries an underscore or
  // a digit. Without that guard this pattern fires on ordinary emphasis, which
  // Portuguese rules use constantly ("DUAS contas", "NUNCA misturar"), and the
  // real orphans drown in the noise. Accented capitals are included in the run
  // so an accent does not slice a word in half: without À-Ý, "ESPECÍFICOS"
  // reports as the meaningless fragment "FICOS".
  { key: 'const', re: /\b(?=[A-ZÀ-Ý0-9_]*[_0-9])[A-ZÀ-Ý][A-ZÀ-Ý0-9_]{3,}\b/g, pick: (m) => m[0] },
  { key: 'flag', re: /(?:^|\s)(--[a-z][\w-]{2,})/g, pick: (m) => m[1] },
];

// Words that match a pattern but carry no information worth protecting.
const NOISE = new Set([
  'NUNCA', 'SEMPRE', 'ATENCAO', 'ATENÇÃO', 'IMPORTANTE', 'OBRIGATORIO', 'OBRIGATÓRIO',
  'NAO', 'NÃO', 'TODOS', 'TODAS', 'CADA', 'ANTES', 'DEPOIS', 'ENTAO', 'ENTÃO',
  'NEVER', 'ALWAYS', 'MUST', 'SHOULD', 'NOTE', 'WARNING', 'TODO', 'ONLY', 'THIS',
  'PESSOAL', 'EMPRESA', 'DEFAULT', 'MAXIMO', 'MÁXIMO', 'CUIDADO', 'REGRA',
]);

function normalize(atom) {
  // Compare on a shape that survives reformatting: a fact moved into a table
  // cell or a bullet is still the same fact.
  return atom.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function extractAtoms(text) {
  const found = new Map(); // normalized -> { atom, kind }
  for (const { key, re, pick } of ATOM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = pick(m);
      if (!raw) continue;
      const atom = raw.trim().replace(/[.,;:]+$/, '');
      if (atom.length < 4) continue;
      if (NOISE.has(atom)) continue;
      const norm = normalize(atom);
      if (!found.has(norm)) found.set(norm, { atom, kind: key });
    }
  }
  return found;
}

export function findOrphans(beforeText, afterTexts) {
  const haystack = afterTexts.map(normalize).join('\n');
  const orphans = [];
  for (const [norm, { atom, kind }] of extractAtoms(beforeText)) {
    if (!haystack.includes(norm)) orphans.push({ atom, kind });
  }
  return orphans;
}

function readOrDie(p, label) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    console.error(`Cannot read ${label}: ${p}`);
    process.exit(1);
  }
}

function collectInto(argv) {
  // --into is repeatable: distilling often splits one rule across a reference
  // file AND the index that points at it.
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--into' && argv[i + 1]) targets.push(argv[i + 1]);
  }
  return targets;
}

function main() {
  const argv = process.argv.slice(2);
  const beforePath = flagValue(argv, '--before');
  const afterPath = flagValue(argv, '--after');
  const intoPaths = collectInto(argv);
  const json = argv.includes('--json');

  if (!beforePath || !afterPath) {
    console.error('Usage: node scripts/verify-distillation.mjs --before <original> --after <distilled> [--into <destination>]... [--json]');
    process.exit(1);
  }

  const beforeText = readOrDie(beforePath, 'before');
  const afterTexts = [
    readOrDie(afterPath, 'after'),
    ...intoPaths.map((p) => readOrDie(p, 'into')),
  ];

  const orphans = findOrphans(beforeText, afterTexts);
  const totalAtoms = extractAtoms(beforeText).size;

  if (json) {
    console.log(JSON.stringify({ beforePath, afterPath, intoPaths, totalAtoms, orphans }, null, 2));
    process.exit(orphans.length > 0 ? 2 : 0);
  }

  console.log('Distillation check');
  console.log(`  before: ${beforePath}`);
  console.log(`  after:  ${[afterPath, ...intoPaths].join(', ')}`);
  console.log(`  high-value atoms in the original: ${totalAtoms}`);
  console.log('');

  if (orphans.length === 0) {
    console.log('  OK. Every identifier, path, command and address in the original still exists');
    console.log('  in the distilled rule or in one of its destinations. Nothing evaporated.');
    process.exit(0);
  }

  console.log(`  ${orphans.length} ORPHANED ATOM(S): present before, in none of the files after.`);
  console.log('  Each of these is a fact that would be deleted, silently, while the byte');
  console.log('  count improves. Move it somewhere or confirm out loud it is disposable.');
  console.log('');
  const byKind = new Map();
  for (const o of orphans) {
    if (!byKind.has(o.kind)) byKind.set(o.kind, []);
    byKind.get(o.kind).push(o.atom);
  }
  for (const [kind, list] of byKind) {
    console.log(`  [${kind}]`);
    for (const a of list) console.log(`    ${a}`);
  }
  process.exit(2);
}

// Only run when invoked directly, so the test suite can import the functions.
if (process.argv[1] && process.argv[1].endsWith('verify-distillation.mjs')) main();
