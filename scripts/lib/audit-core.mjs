// audit-core.mjs
// Measurement and heuristic-detection logic behind audit.mjs (capabilities
// A, B, C) and reused by apply.mjs for the one mechanical fix it is allowed
// to make (adding `paths:` frontmatter to a conditional-rule candidate).
//
// Everything here is read-only. Nothing in this file writes to disk.

import fs from 'node:fs';
import path from 'node:path';

export function bytesOf(str) {
  return Buffer.byteLength(str, 'utf8');
}

export function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function listMarkdownFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function isDirectoryFollowingSymlinks(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory(); // statSync follows symlinks, unlike Dirent.isDirectory()
  } catch {
    return false; // broken symlink or race with deletion
  }
}

export function listSkillDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => isDirectoryFollowingSymlinks(path.join(dir, e.name)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Detects a leading YAML frontmatter block (the file's first line must be
// exactly "---") and whether it declares a top-level `paths:` key. This is
// intentionally not a full YAML parser: the only thing that matters for
// progressive disclosure is presence of `paths:`, not its structure.
export function parseFrontmatter(content) {
  const empty = { hasFrontmatter: false, hasPaths: false, block: '' };
  if (!content.startsWith('---')) return empty;

  const firstLineEnd = content.indexOf('\n');
  if (firstLineEnd === -1) return empty;
  if (content.slice(0, firstLineEnd).trim() !== '---') return empty;

  const closeIdx = content.indexOf('\n---', firstLineEnd);
  if (closeIdx === -1) return empty;

  const block = content.slice(firstLineEnd + 1, closeIdx);
  return { hasFrontmatter: true, hasPaths: /^paths\s*:/m.test(block), block };
}

function loadRule(filePath) {
  const content = readFileSafe(filePath) ?? '';
  const fm = parseFrontmatter(content);
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: bytesOf(content),
    conditional: fm.hasPaths,
    content,
  };
}

// Capability A: measure the config's context budget and detect whether the
// three-layer architecture (CLAUDE.md -> rules/ -> references/) is in place.
export function measureConfig(configDir) {
  const claudeMdPath = path.join(configDir, 'CLAUDE.md');
  const claudeMdContent = readFileSafe(claudeMdPath);
  const claudeMdBytes = claudeMdContent ? bytesOf(claudeMdContent) : 0;

  const rulesDir = path.join(configDir, 'rules');
  const rules = listMarkdownFiles(rulesDir).map(loadRule);
  const alwaysLoadedRules = rules.filter((r) => !r.conditional);
  const conditionalRules = rules.filter((r) => r.conditional);

  const referencesDir = path.join(configDir, 'references');
  const referenceFiles = listMarkdownFiles(referencesDir).map((fp) => ({
    path: fp,
    name: path.basename(fp),
    bytes: bytesOf(readFileSafe(fp) ?? ''),
  }));

  const skills = listSkillDirs(path.join(configDir, 'skills'));

  const contextDir = path.join(configDir, 'context');
  const contextCardFiles = listMarkdownFiles(contextDir);
  const contextCardsBytes = contextCardFiles.reduce(
    (sum, fp) => sum + bytesOf(readFileSafe(fp) ?? ''),
    0,
  );

  const alwaysLoadedRulesBytes = alwaysLoadedRules.reduce((s, r) => s + r.bytes, 0);
  const conditionalBytes = conditionalRules.reduce((s, r) => s + r.bytes, 0);
  const referencesBytes = referenceFiles.reduce((s, r) => s + r.bytes, 0);

  return {
    configDir,
    claudeMdPath,
    claudeMdContent,
    claudeMdBytes,
    rules,
    alwaysLoadedRules,
    conditionalRules,
    referenceFiles,
    skills,
    contextCardFiles,
    contextCardsBytes,
    alwaysLoadedBytes: claudeMdBytes + alwaysLoadedRulesBytes,
    alwaysLoadedRulesBytes,
    conditionalBytes,
    referencesBytes,
    threeLayer: {
      claudeMd: !!claudeMdContent,
      rulesDir: fs.existsSync(rulesDir),
      referencesDir: fs.existsSync(referencesDir),
      hasConditionalRules: conditionalRules.length > 0,
    },
  };
}

// Capability B: dead pointers.
// Pattern is deliberately scoped to what the spec asks for: literal paths
// starting with rules/, references/, hooks/ or skills/ cited inside
// CLAUDE.md or a rule file. Bare filenames without one of these prefixes
// (e.g. a table row that just says `foo.md`) are out of scope: the tool
// cannot reliably tell those apart from prose without more context, and a
// false "dead pointer" is worse than a missed one.
const POINTER_RE = /\b(rules|references|hooks|skills)\/[\w.-]+(?:\/[\w.-]+)*/g;

export function findPointers(text) {
  const found = new Set();
  let m;
  POINTER_RE.lastIndex = 0;
  while ((m = POINTER_RE.exec(text)) !== null) {
    const candidate = m[0].replace(/\.+$/, '').replace(/\/+$/, '');
    if (candidate.split('/').length < 2) continue; // just "rules/" with nothing after it
    found.add(candidate);
  }
  return [...found];
}

function sourceDocs(measured) {
  return [
    { name: 'CLAUDE.md', content: measured.claudeMdContent ?? '' },
    ...measured.alwaysLoadedRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
    ...measured.conditionalRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
  ];
}

export function findDeadPointers(measured) {
  const dead = [];
  const seen = new Set();
  for (const doc of sourceDocs(measured)) {
    for (const pointer of findPointers(doc.content)) {
      const key = `${doc.name}::${pointer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolvedPath = path.join(measured.configDir, pointer);
      if (!fs.existsSync(resolvedPath)) {
        dead.push({ citedIn: doc.name, target: pointer, resolvedPath });
      }
    }
  }
  return dead;
}

// --- Capability C1: duplication -------------------------------------------

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'ou', 'que',
  'em', 'um', 'uma', 'para', 'com', 'por', 'se', 'ao', 'aos', 'the', 'an',
  'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be',
]);

function normalizeLine(line) {
  return line
    .replace(/[`*_#>]/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .trim()
    .toLowerCase();
}

function wordSet(line) {
  return new Set(
    line
      .split(/[^a-z0-9à-ÿ]+/i)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function significantLines(content, minLen = 50) {
  return content
    .split('\n')
    .map(normalizeLine)
    .filter((l) => l.length >= minLen && !l.startsWith('|'));
}

export function findDuplication(measured, { threshold = 0.6 } = {}) {
  const claudeLines = significantLines(measured.claudeMdContent ?? '');
  const claudeLineWords = claudeLines.map((l) => ({ line: l, words: wordSet(l) }));
  const results = [];

  for (const rule of measured.alwaysLoadedRules) {
    for (const ruleLine of significantLines(rule.content)) {
      const ruleWords = wordSet(ruleLine);
      for (const claudeLine of claudeLineWords) {
        const score = jaccard(claudeLine.words, ruleWords);
        if (score >= threshold) {
          results.push({
            file: `rules/${rule.name}`,
            claudeLine: claudeLine.line,
            ruleLine,
            score: Math.round(score * 100) / 100,
          });
        }
      }
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

// --- Capability C2: contradiction candidates -------------------------------

const ACTION_VERBS = [
  { stem: 'delete', patterns: [/apag\w*/i, /delet\w*/i, /remov\w*/i] },
  { stem: 'commit', patterns: [/commit\w*/i] },
  { stem: 'push', patterns: [/\bpush\w*/i] },
  { stem: 'ask', patterns: [/pergunt\w*/i, /\bask\w*/i, /aprova\w*/i, /approv\w*/i] },
  { stem: 'edit', patterns: [/edit\w*/i, /altera\w*/i, /modific\w*/i] },
  { stem: 'overwrite', patterns: [/sobrescrev\w*/i, /overwrit\w*/i] },
  { stem: 'skip', patterns: [/\bpul[ao]\w*/i, /skip\w*/i, /ignor\w*/i] },
];

const NEVER_RE = /\b(nunca|never)\b/i;
const ALWAYS_RE = /\b(sempre|always)\b/i;

function matchVerbStem(line) {
  const hit = ACTION_VERBS.find((v) => v.patterns.some((p) => p.test(line)));
  return hit ? hit.stem : null;
}

function collectPolaritySentences(sources) {
  const never = [];
  const always = [];
  for (const src of sources) {
    for (const rawLine of src.content.split('\n')) {
      const line = rawLine.trim();
      if (line.length < 15) continue;
      const stem = matchVerbStem(line);
      if (!stem) continue;
      const entry = { file: src.name, line, stem, words: wordSet(normalizeLine(line)) };
      if (NEVER_RE.test(line)) never.push(entry);
      else if (ALWAYS_RE.test(line)) always.push(entry);
    }
  }
  return { never, always };
}

// Heuristic only: flags lines across two always-loaded docs that use
// opposite polarity markers (nunca/never vs sempre/always) on the same
// action-verb stem with overlapping wording. This is a candidate for human
// review, never a proven contradiction.
export function findContradictionCandidates(measured) {
  const sources = sourceDocsAlwaysLoadedOnly(measured);
  const { never, always } = collectPolaritySentences(sources);

  const candidates = [];
  for (const n of never) {
    for (const a of always) {
      if (n.file === a.file || n.stem !== a.stem) continue;
      const overlap = jaccard(n.words, a.words);
      if (overlap >= 0.15) {
        candidates.push({
          stem: n.stem,
          neverFile: n.file,
          neverLine: n.line,
          alwaysFile: a.file,
          alwaysLine: a.line,
          overlap: Math.round(overlap * 100) / 100,
        });
      }
    }
  }
  return candidates.sort((a, b) => b.overlap - a.overlap);
}

function sourceDocsAlwaysLoadedOnly(measured) {
  return [
    { name: 'CLAUDE.md', content: measured.claudeMdContent ?? '' },
    ...measured.alwaysLoadedRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
  ];
}

// --- Capability C3: conditional-rule candidates ----------------------------

const FILE_TYPE_CATEGORIES = [
  { key: 'lint', label: 'Lint/format', keywords: /\b(eslint|lint|prettier|stylelint|linter)\b/gi, suggestedPaths: ['**/*.{js,ts,jsx,tsx}'] },
  { key: 'test', label: 'Tests', keywords: /\b(jest|vitest|pytest|test|teste|testes|spec)\b/gi, suggestedPaths: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**'] },
  { key: 'migration', label: 'DB migrations', keywords: /\b(migration|migrate|migração|migrações|alembic)\b/gi, suggestedPaths: ['**/migrations/**'] },
  { key: 'css', label: 'CSS/styling', keywords: /\b(css|scss|sass|tailwind|styling|estilo)\b/gi, suggestedPaths: ['**/*.css', '**/*.scss'] },
  { key: 'typescript', label: 'TypeScript', keywords: /\btypescript\b|\.tsx?\b/gi, suggestedPaths: ['**/*.ts', '**/*.tsx'] },
  { key: 'python', label: 'Python', keywords: /\bpython\b|\.py\b/gi, suggestedPaths: ['**/*.py'] },
  { key: 'sql', label: 'SQL', keywords: /\bsql\b|\bpostgres\w*|\bmysql\b/gi, suggestedPaths: ['**/*.sql'] },
  { key: 'docker', label: 'Docker/infra', keywords: /\bdocker\w*|\bdockerfile\b|\bkubernetes\b/gi, suggestedPaths: ['**/Dockerfile', '**/*.yaml'] },
];

function categoryHits(content) {
  return FILE_TYPE_CATEGORIES
    .map((cat) => ({ cat, count: (content.match(cat.keywords) ?? []).length }))
    .filter((s) => s.count > 0);
}

// Absolute hit counts are a trap. A 30 KB rule about how to run a project can
// mention "test" a dozen times in passing and still be about everything else,
// while the category list here only covers file types, so unrelated themes
// (git, deploy, review) are invisible to it and the rule looks monothematic.
// Making such a rule conditional silently switches off the user's most
// important instructions on every session that does not touch a test file,
// and reports the loss as a saving.
//
// So the bar is density, not volume: the category has to own a real share of
// the words in the file, and there has to be enough of it to not be noise.
const MIN_HITS = 8;          // below this, one paragraph can trip it
const MIN_DENSITY = 0.01;    // the topic must be at least 1% of the words

export function findConditionalCandidates(measured) {
  const candidates = [];
  for (const rule of measured.alwaysLoadedRules) {
    const hits = categoryHits(rule.content);
    if (hits.length !== 1) continue;
    const [{ cat, count }] = hits;
    const words = rule.content.split(/\s+/).filter(Boolean).length || 1;
    const density = count / words;
    if (count < MIN_HITS || density < MIN_DENSITY) continue;
    candidates.push({
      file: `rules/${rule.name}`,
      category: cat.label,
      hits: count,
      density: Number((density * 100).toFixed(2)),
      words,
      suggestedPaths: cat.suggestedPaths,
    });
  }
  return candidates;
}
