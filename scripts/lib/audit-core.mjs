// audit-core.mjs
// Measurement and heuristic-detection logic behind audit.mjs (capabilities
// A, B, C) and reused by apply.mjs for the one mechanical fix it is allowed
// to make (adding `paths:` frontmatter to a conditional-rule candidate).
//
// Everything here is read-only. Nothing in this file writes to disk.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

// --- @import resolution ----------------------------------------------------
//
// rules/ is not the only always-loaded mechanism. An `@path/file.md` line
// inside CLAUDE.md makes Claude Code inline that file's content into every
// single session, exactly like the memory file itself. A config built on
// imports has no rules/ directory at all, so measuring only CLAUDE.md +
// rules/ reports a small fraction of what is really loaded, and then reports
// the imported files as "on demand" -- the exact opposite of the truth.
//
// The scanner below mirrors the parser inside the installed Claude Code
// binary (read from the build, not guessed):
//   - capture regex /(?:^|\s)@((?:[^\s\\]|\\ )+)/g. The @ must sit at the
//     start of the text or right after whitespace, which is what keeps
//     e-mails (name@host.com) and version suffixes (pkg@latest) out of it,
//     and a backslash cannot appear inside the path (so a Windows path only
//     works written with forward slashes);
//   - the path ends at the first whitespace, `\ ` is an escaped space, and a
//     `#` truncates it (@file.md#section imports file.md);
//   - the candidate is accepted if it starts with ./ , ../ , ~/ or / (but not
//     "/" alone). With no such prefix it must begin with [a-zA-Z0-9._-] AND
//     carry a readable file extension, or else exist on disk -- see
//     looksLikeImportPath() for why the textual half cannot stand alone;
//   - it resolves against the directory of the FILE THAT IMPORTS, never the
//     config root and never the cwd;
//   - imports nest up to four hops and a visited set cuts cycles; the walk is
//     breadth-first so a file is always found at its shallowest depth (see
//     resolveImports). A file whose extension is not text is skipped with a
//     warning (it loads nothing, same as a missing file).
const MAX_IMPORT_HOPS = 4;

// Extensions Claude Code is willing to inline. Anything else prints
// "Skipping non-text file in @include", i.e. the @ line loads nothing at all.
// A path with no extension is allowed through, matching the binary.
const IMPORTABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.text', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.ts', '.tsx',
  '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.pyi', '.pyw', '.rb', '.erb',
  '.rake', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.cpp', '.cc',
  '.cxx', '.h', '.hpp', '.hxx', '.cs', '.swift', '.sh', '.bash', '.zsh',
  '.fish', '.ps1', '.bat', '.cmd', '.env', '.ini', '.cfg', '.conf', '.config',
  '.properties', '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte',
  '.astro', '.ejs', '.hbs', '.pug', '.jade', '.php', '.pl', '.pm', '.lua',
  '.r', '.dart', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc',
  '.edn', '.hs', '.lhs', '.elm', '.ml', '.mli', '.f', '.f90', '.f95', '.for',
  '.cmake', '.make', '.makefile', '.gradle', '.sbt', '.rst', '.adoc',
  '.asciidoc', '.org', '.tex', '.latex', '.lock', '.log', '.diff', '.patch',
]);

function blankOut(chunk) {
  return chunk.replace(/[^\n]/g, ' '); // same length, newlines kept: offsets and the "@ after whitespace" rule stay valid
}

// The real parser walks the markdown token tree and simply skips `code`,
// `codespan` and HTML comments, so an @ shown as an example never becomes an
// import. We work on raw text, so those regions are blanked out first. Getting
// this wrong in the permissive direction only produces a visible "broken
// import" line; getting it wrong in the strict direction would silently drop
// bytes from the always-loaded total, which is the bug this whole change
// exists to fix.
export function maskUnscannable(text) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, blankOut);
  const lines = withoutComments.split('\n');

  let fence = null;          // the opening ``` / ~~~ run while inside a fenced block
  let inIndentedCode = false;
  let listOpen = false;      // inside a list, indentation is list content, not code
  let prevBlank = true;      // an indented code block cannot interrupt a paragraph

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceHit = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fence) {
      const closes = fenceHit && fenceHit[1][0] === fence[0] && fenceHit[1].length >= fence.length;
      lines[i] = blankOut(line);
      if (closes) fence = null;
      continue;
    }
    if (fenceHit) {
      fence = fenceHit[1];
      lines[i] = blankOut(line);
      prevBlank = false;
      continue;
    }
    if (line.trim() === '') {
      prevBlank = true; // blank lines neither open nor close an indented block
      continue;
    }

    const indented = /^(?: {4}|\t)/.test(line);
    if (inIndentedCode) {
      if (indented) { lines[i] = blankOut(line); prevBlank = false; continue; }
      inIndentedCode = false;
    }
    if (indented && prevBlank && !listOpen) {
      inIndentedCode = true;
      lines[i] = blankOut(line);
      prevBlank = false;
      continue;
    }

    if (/^ {0,3}(?:[-*+]|\d+[.)])\s/.test(line)) listOpen = true;
    else if (!indented) listOpen = false;
    prevBlank = false;
  }

  // Inline code spans, after the fences are gone. Restricted to a single line
  // on purpose: a stray backtick must not swallow the rest of the document.
  return lines.join('\n').replace(/(`+)[^\n]*?\1/g, blankOut);
}

// Sentence punctuation glued to the end of a token is not part of the path:
// "the rule lives in @doc.md." imports doc.md, not "doc.md.". Without this trim
// the spec never resolves and is reported as a broken import of a file nobody
// ever wrote.
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

function hasImportableExtension(spec) {
  const ext = path.extname(spec).toLowerCase();
  return ext !== '' && IMPORTABLE_EXTENSIONS.has(ext);
}

// Applies the parser's own normalisation to a raw capture: `#section` truncates
// the path, `\ ` is an escaped space, and trailing punctuation is dropped.
function normalizeSpec(raw) {
  let spec = raw;
  const hash = spec.indexOf('#');
  if (hash !== -1) spec = spec.slice(0, hash);
  return spec.replace(/\\ /g, ' ').replace(TRAILING_PUNCT_RE, '');
}

// Purely textual test: does this token LOOK like a path the parser would try to
// inline? An explicit prefix (./ ../ ~/ /) is the author saying "this is a
// file", so it is honoured as written, extension or not. With no prefix the
// token has to carry a readable file extension, because prose is full of @
// tokens that are not paths: scoped npm names (@tanstack/react-query), handles
// (@robson), and the word @import itself whenever a doc explains the mechanism.
//
// The guard this replaces (`if (spec.startsWith('@')) return false`) could
// never fire: the capture group of findImportSpecs already ate the @, so the
// spec of "@tanstack/react-query" arrives as "tanstack/react-query" and the
// test was dead code. Every such token became a phantom broken import.
//
// Failing here is not a death sentence: scan() gives the token a second chance
// when the resolved path exists on disk, so an extension-less or non-text file
// really sitting there is still measured. Guessing strictly from text, then
// deferring to the filesystem, keeps prose out without ever dropping bytes.
function looksLikeImportPath(spec) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('~/')) return true;
  if (spec.startsWith('/')) return spec !== '/';
  if (!/^[a-zA-Z0-9._-]/.test(spec)) return false; // #%^&*() and a second @ are out
  return hasImportableExtension(spec);
}

// Every @ token in the text, normalised, each tagged with whether it textually
// looks like a path. The tag travels with the spec so the filesystem can have
// the last word in scan().
export function findImportSpecs(content) {
  const scannable = maskUnscannable(content);
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g; // built per call: recursion must not share lastIndex
  const specs = [];
  let m;
  while ((m = re.exec(scannable)) !== null) {
    const spec = normalizeSpec(m[1]);
    if (!spec) continue;
    specs.push({ spec, looksLikePath: looksLikeImportPath(spec) });
  }
  return specs;
}

// Blanks out the "@path" tokens so the dead-pointer scan does not read them
// again. Without this an @import of a missing file is reported twice (once as
// a broken import, once as a dead pointer), and an escaped space produces a
// phantom pointer, because POINTER_RE stops at the backslash.
//
// Only path-looking tokens are masked. A token that is prose (a handle, a
// scoped package name) has to stay visible, otherwise this masking would HIDE a
// genuine dead pointer that the public version reports -- silencing capability
// B is a worse bug than the double report it exists to prevent.
export function maskImportSpecs(text) {
  return text.replace(/(^|\s)@((?:[^\s\\]|\\ )+)/g, (full, lead, raw) => {
    const spec = normalizeSpec(raw);
    if (!spec || !looksLikeImportPath(spec)) return full;
    return lead + ' ' + blankOut(raw);
  });
}

function resolveImportPath(spec, baseDir) {
  if (spec === '~') return os.homedir();
  if (spec.startsWith('~/')) return path.resolve(os.homedir(), spec.slice(2));
  return path.resolve(baseDir, spec); // relative to the importing file, per the parser
}

// Reports an imported file the way the user wrote it, so the audit output can
// be matched back to a line in CLAUDE.md: "@context/git.md", not an absolute
// path. Files outside the config dir keep their full path (with forward
// slashes, so Windows output stays copy-pasteable).
function importLabel(absPath, configDir) {
  const rel = path.relative(configDir, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absPath.replace(/\\/g, '/');
  return rel.split(path.sep).join('/');
}

// Walks the import graph starting from `content` (a file living in baseDir).
// Returns every document that really gets loaded, plus every @ line that
// loads nothing. Both lists are deduplicated by resolved path, matching the
// runtime: importing the same file twice costs its bytes once.
//
// The walk is breadth-first, one hop at a time, and that is load-bearing. A
// depth-first walk sharing one visited set can reach a file down a long chain
// first, stamp it at depth 4, decline to descend because the hop budget is
// spent, and then throw the same file away when it turns up again as a direct
// import of CLAUDE.md. Everything that file imports disappears from the budget
// without a single warning: not in importedDocs, not in missingImports. The
// runtime would have loaded it at depth 1 and its children at depth 2. Worse,
// the outcome depended on the order the @ lines happened to appear in the text,
// so simply swapping two lines in CLAUDE.md changed the reported total.
// Level order guarantees every file is discovered at its smallest reachable
// depth, which is what the runtime does.
export function resolveImports(content, baseDir, configDir, { maxHops = MAX_IMPORT_HOPS, rootLabel = 'CLAUDE.md' } = {}) {
  const docs = [];
  const missing = [];
  const seen = new Set();
  let frontier = [{ text: content, dir: baseDir, depth: 0, citedIn: rootLabel }];

  function scan(text, dir, depth, citedIn, nextLevel) {
    for (const { spec, looksLikePath } of findImportSpecs(text)) {
      const resolved = resolveImportPath(spec, dir);
      let stat = null;
      try { stat = fs.statSync(resolved); } catch { /* missing or unreadable */ }
      if (stat && !stat.isFile()) continue; // a directory is dropped by the parser before it becomes an import
      // A token that does not look like a path counts only if the filesystem
      // contradicts the guess: a real file with no extension (or with a
      // non-text one) is a real import, while a handle or a scoped package
      // name resolves to nothing and is just prose.
      if (!looksLikePath && !stat) continue;

      const key = path.resolve(resolved);
      if (seen.has(key)) continue; // cycle A -> B -> A, or the same file imported twice
      seen.add(key);

      const entry = { spec, citedIn, resolvedPath: resolved, depth: depth + 1 };
      if (!stat) { missing.push({ ...entry, reason: 'not-found' }); continue; }

      const ext = path.extname(resolved).toLowerCase();
      if (ext && !IMPORTABLE_EXTENSIONS.has(ext)) { missing.push({ ...entry, reason: 'non-text' }); continue; }

      const fileContent = readFileSafe(resolved);
      if (fileContent === null) { missing.push({ ...entry, reason: 'unreadable' }); continue; }

      const doc = {
        path: resolved,
        rel: importLabel(resolved, configDir),
        name: path.basename(resolved),
        bytes: bytesOf(fileContent),
        content: fileContent,
        depth: depth + 1,
        citedIn,
        // RESOLVED (was the contradiction between this file and audit.mjs /
        // apply.mjs / SKILL.md): PROVENANCE decides, never the frontmatter. A
        // file reached through an `@` import is inlined into every session in
        // full, so its cost is always the whole file.
        //
        // Settled by a controlled 2x2 experiment on Claude Code v2.1.220, run
        // twice with identical results: four fixture files each carrying a
        // unique invented token, two reached by @import and two living in
        // .claude/rules/, one of each pair declaring a `paths:` glob that
        // matches nothing. The session was queried with Read/Bash/Glob/Grep
        // disabled, so a token could only be named if it had really been
        // injected. The rules/ file with the non-matching `paths:` did NOT
        // appear (positive control: the gate works, and works only there);
        // the IMPORTED file with the very same frontmatter DID.
        //
        // The line that used to sit here (`conditional: hasPaths`) zeroed the
        // cost of such a file. That is under-reporting dressed as a saving,
        // the worst kind of wrong number, because it looks like good news
        // while the context is spent in silence. The declaration is carried
        // forward only so the audit can WARN that it is being ignored.
        //
        // Known and deliberate residual: the frontmatter block itself is
        // stripped before injection, so counting the whole file overestimates
        // by a few dozen tokens. Left alone on purpose -- the error falls on
        // the safe side, and chasing it risks bringing under-reporting back.
        // Fix it later, isolated, with a test of its own.
        declaresPaths: parseFrontmatter(fileContent).hasPaths,
      };
      docs.push(doc);
      if (doc.depth < maxHops) {
        nextLevel.push({ text: fileContent, dir: path.dirname(resolved), depth: doc.depth, citedIn: `@${doc.rel}` });
      }
    }
  }

  while (frontier.length > 0) {
    const nextLevel = [];
    for (const node of frontier) scan(node.text, node.dir, node.depth, node.citedIn, nextLevel);
    frontier = nextLevel;
  }
  return { docs, missing };
}

// Capability A: measure the config's context budget and detect whether the
// three-layer architecture (CLAUDE.md -> rules/ -> references/, or CLAUDE.md
// -> @import files -> on-demand docs) is in place.
export function measureConfig(configDir) {
  const claudeMdPath = path.join(configDir, 'CLAUDE.md');
  const claudeMdContent = readFileSafe(claudeMdPath);
  const claudeMdBytes = claudeMdContent ? bytesOf(claudeMdContent) : 0;

  const rulesDir = path.join(configDir, 'rules');
  const rules = listMarkdownFiles(rulesDir).map(loadRule);

  // Everything CLAUDE.md pulls in with @ is always loaded too, so it is
  // measured before the on-demand buckets: a file that is imported must not
  // also be counted as a reference or a context card sitting on the shelf.
  const { docs: allImported, missing: missingImports } = claudeMdContent
    ? resolveImports(claudeMdContent, configDir, configDir)
    : { docs: [], missing: [] };
  const importedPaths = new Set(allImported.map((d) => path.resolve(d.path)));

  // Provenance, not frontmatter (see the long note in resolveImports). A rule
  // that CLAUDE.md ALSO pulls in with @ is inlined verbatim, so its `paths:`
  // gate never runs and it is always loaded whatever the frontmatter says.
  // Classifying it as conditional dropped its bytes out of the always-loaded
  // total while the session paid for them in full. Pinned by the
  // "rules/ file that is ALSO imported" case in tests/imports.test.mjs.
  const isImportedRule = (r) => importedPaths.has(path.resolve(r.path));
  const alwaysLoadedRules = rules.filter((r) => !r.conditional || isImportedRule(r));
  const conditionalRules = rules.filter((r) => r.conditional && !isImportedRule(r));

  // A file cannot be paid for twice. If an import points at something already
  // counted as a rule, the rule accounting wins and the duplicate is dropped.
  const rulePaths = new Set(rules.map((r) => path.resolve(r.path)));
  const newlyImported = allImported.filter((d) => !rulePaths.has(path.resolve(d.path)));
  // EVERY imported file, with no exception for the ones declaring `paths:`.
  const importedDocs = newlyImported;
  // Kept so the JSON shape does not change under consumers, and structurally
  // empty from now on: an imported file is never conditional. The files that
  // declare `paths:` and get imported anyway are reported through
  // importsIgnoringPaths below, where they can be acted on.
  const importedConditionalDocs = [];
  const importedBytes = importedDocs.reduce((s, d) => s + d.bytes, 0);
  const importedConditionalBytes = 0;

  // The user-facing prize of the experiment: someone wrote `paths:` at the top
  // of a file believing they had made it conditional and cheap, and the @import
  // line silently turns it into fixed weight on every session. Nothing else in
  // the config reveals this, so the audit has to say it out loud.
  const citedInOf = (abs) => allImported.find((d) => path.resolve(d.path) === abs)?.citedIn ?? 'CLAUDE.md';
  const importsIgnoringPaths = [
    ...newlyImported
      .filter((d) => d.declaresPaths)
      .map((d) => ({ file: `@${d.rel}`, importedBy: d.citedIn, bytes: d.bytes })),
    ...rules
      .filter((r) => r.conditional && isImportedRule(r))
      .map((r) => ({ file: `rules/${r.name}`, importedBy: citedInOf(path.resolve(r.path)), bytes: r.bytes })),
  ];

  const referencesDir = path.join(configDir, 'references');
  const referenceFiles = listMarkdownFiles(referencesDir)
    .filter((fp) => !importedPaths.has(path.resolve(fp))) // imported ones are always loaded, not on demand
    .map((fp) => ({
      path: fp,
      name: path.basename(fp),
      bytes: bytesOf(readFileSafe(fp) ?? ''),
    }));

  const skills = listSkillDirs(path.join(configDir, 'skills'));

  const contextDir = path.join(configDir, 'context');
  const contextCardFiles = listMarkdownFiles(contextDir)
    .filter((fp) => !importedPaths.has(path.resolve(fp)));
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
    importedDocs,
    importedBytes,
    importedConditionalDocs,
    importedConditionalBytes,
    // Every path reached by an @import, including the ones that land inside
    // rules/. Exported because "is this file imported?" is the only question
    // that decides whether a paths: frontmatter would do anything at all, and
    // apply.mjs has to be able to ask it.
    importedPaths,
    importsIgnoringPaths,
    missingImports,
    alwaysLoadedBytes: claudeMdBytes + alwaysLoadedRulesBytes + importedBytes,
    alwaysLoadedRulesBytes,
    conditionalBytes,
    referencesBytes,
    threeLayer: {
      claudeMd: !!claudeMdContent,
      rulesDir: fs.existsSync(rulesDir),
      referencesDir: fs.existsSync(referencesDir),
      hasConditionalRules: conditionalRules.length > 0,
      // Layer 2 can be built with @import lines instead of rules/, and layer 3
      // is whatever stays on the shelf: references/ plus the context cards
      // nobody imports.
      importLayer: newlyImported.length > 0,
      onDemandDocs: referenceFiles.length + contextCardFiles.length > 0,
    },
  };
}

// Every document that makes up the always-loaded total, largest first, with the
// share each one holds. A single total ("99754 bytes across 23 files") is an
// opaque number: it says a diet is needed and nothing about where to start
// cutting. The list turns it into something traceable, and it is exactly the
// input the distillation pass in SKILL.md asks for ("look at the always-loaded
// docs sorted by size"). The sum of the rows is alwaysLoadedBytes by
// construction: an imported file is never also a rule (newlyImported drops
// those), so nothing is counted twice.
export function alwaysLoadedInventory(measured) {
  const items = [];
  if (measured.claudeMdContent != null) items.push({ file: 'CLAUDE.md', bytes: measured.claudeMdBytes });
  for (const r of measured.alwaysLoadedRules) items.push({ file: `rules/${r.name}`, bytes: r.bytes });
  for (const d of measured.importedDocs ?? []) items.push({ file: `@${d.rel}`, bytes: d.bytes });

  const total = items.reduce((s, i) => s + i.bytes, 0);
  return items
    .map((i) => ({ ...i, percent: total > 0 ? Number(((i.bytes / total) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}

// Capability B: dead pointers.
// Pattern is deliberately scoped to what the spec asks for: literal paths
// starting with rules/, references/, hooks/ or skills/ cited inside
// CLAUDE.md or a rule file. Bare filenames without one of these prefixes
// (e.g. a table row that just says `foo.md`) are out of scope: the tool
// cannot reliably tell those apart from prose without more context, and a
// false "dead pointer" is worse than a missed one.
// context/, commands/ and agents/ are official Claude Code directories too,
// and a config that keeps its rules in context/ cites them constantly. The
// pattern stays narrow (a real directory prefix plus at least one path
// segment) so prose like "seguem em context/ (intactos)" cannot trip it.
const POINTER_RE = /\b(rules|references|hooks|skills|context|commands|agents)\/[\w.-]+(?:\/[\w.-]+)*/g;

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

// Imported files are named the way the user wrote them ("@context/git.md"),
// so every heuristic below can point back at the exact line of CLAUDE.md that
// pulls the file in.
function importedSourceDocs(measured) {
  return [
    ...(measured.importedDocs ?? []).map((d) => ({ name: `@${d.rel}`, content: d.content })),
    ...(measured.importedConditionalDocs ?? []).map((d) => ({ name: `@${d.rel}`, content: d.content })),
  ];
}

function sourceDocs(measured) {
  return [
    { name: 'CLAUDE.md', content: measured.claudeMdContent ?? '' },
    ...measured.alwaysLoadedRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
    ...measured.conditionalRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
    ...importedSourceDocs(measured),
  ];
}

// Broken @import lines are NOT merged in here. They are just as severe (the
// file silently does not load), but they are a different finding with a
// different fix, they are reported in their own section, and mixing them in
// would change what capability B returns for a config that has no imports at
// all -- the number a user of the public version already knows.
export function findDeadPointers(measured) {
  const dead = [];
  const seen = new Set();
  for (const doc of sourceDocs(measured)) {
    for (const pointer of findPointers(maskImportSpecs(doc.content))) {
      const key = `${doc.name}::${pointer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolvedPath = path.join(measured.configDir, pointer);
      if (!fs.existsSync(resolvedPath)) {
        // No `kind` discriminator: it only existed to tell a broken @import
        // apart from a stale path, and broken imports are reported on their
        // own now. One constant value would be noise, and dropping it keeps
        // this list byte-identical to what the public version emits.
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

  // Every doc that loads on every session, not just the ones under rules/:
  // in an import-based config the imported files ARE the always-loaded layer,
  // so skipping them would leave the duplication check with nothing to read.
  const alwaysLoadedDocs = [
    ...measured.alwaysLoadedRules.map((r) => ({ name: `rules/${r.name}`, content: r.content })),
    ...(measured.importedDocs ?? []).map((d) => ({ name: `@${d.rel}`, content: d.content })),
  ];

  for (const rule of alwaysLoadedDocs) {
    for (const ruleLine of significantLines(rule.content)) {
      const ruleWords = wordSet(ruleLine);
      for (const claudeLine of claudeLineWords) {
        const score = jaccard(claudeLine.words, ruleWords);
        if (score >= threshold) {
          results.push({
            file: rule.name,
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
    // Imported files sit in the same session as CLAUDE.md, so a "never" here
    // against an "always" there is a real contradiction the model has to live
    // with. Conditional imports are left out: they are not always in play.
    ...(measured.importedDocs ?? []).map((d) => ({ name: `@${d.rel}`, content: d.content })),
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

// Markers that turn a line into "this is an example" or "this is what NOT to
// do". Kept short and literal on purpose: every entry has to be something a
// human would read as a citation rather than a usage.
const EXAMPLE_OR_NEGATION_RE = new RegExp(
  [
    'exemplos?', 'example', 'e\\.g\\.', '\\bex\\b\\s*[.:]', '\\bi\\.e\\.',
    'anti-?padr[aã]o', 'anti-?pattern',
    'nunca', 'never', 'jamais',
    'n[aã]o\\s+(?:fa[cç]a|fazer|use|usar|rode|rodar|chame|chamar)',
    "do\\s+not\\b", "don'?t\\b", '\\bavoid\\b',
    '\\berrado\\b', '\\bproibido\\b', '\\bwrong\\b',
    '❌', '✗',
  ].join('|'),
  'i',
);

// The content a topic detector is allowed to count, which is not the same as
// the content of the file.
//
// A keyword only signals "this file is ABOUT X" when X is being used, not when
// X is being quoted as the mistake to avoid. The case that forced this:
// context/watchdog-nome-generico-cross-project.md is a live safety rule that
// forbids killing processes by generic name on a machine running several
// projects at once. It spells the anti-pattern out -- `*coletor.py*`,
// `main.py`, `python` -- and the raw counter read 13 "Python" hits and proposed
// dropping the rule from the always-loaded budget. Acting on that suggestion
// would switch off an active protection while the byte count improved: exactly
// the failure mode this detector already guards against with density, arriving
// through a door density cannot close.
//
// Two kinds of occurrence are therefore dropped before counting:
//   1. anything inside code (fenced blocks, indented blocks and inline `spans`)
//      -- where anti-pattern samples are almost always written, and where the
//      import scanner already refuses to look for the same reason;
//   2. whole lines carrying an example or negation marker.
//
// Both only ever REMOVE hits, so the error can fall on one side only: the tool
// suggests less than it could, never more. That is the correct direction for a
// heuristic whose false positives cost the user a rule.
export function contentForTopicDetection(content) {
  return maskUnscannable(content)
    .split('\n')
    .map((line) => (EXAMPLE_OR_NEGATION_RE.test(line) ? '' : line))
    .join('\n');
}

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

function monothematicHit(content) {
  const hits = categoryHits(contentForTopicDetection(content));
  if (hits.length !== 1) return null;
  const [{ cat, count }] = hits;
  // Hits come from the filtered text, the word count from the WHOLE file. The
  // denominator is the file's real weight -- every byte of it loads, examples
  // included -- so keeping it whole holds density down and keeps the threshold
  // on the conservative side. Using the filtered text on both sides would
  // shrink the denominator and quietly make the detector more eager, which is
  // the opposite of what this is for.
  const words = content.split(/\s+/).filter(Boolean).length || 1;
  const density = count / words;
  if (count < MIN_HITS || density < MIN_DENSITY) return null;
  return { cat, count, words, density };
}

// Only rules/ files are returned here, and that is deliberate: the fix this
// list implies is a `paths:` frontmatter, which is a rules/ feature.
//
// Living under rules/ is not enough, though. A rule that CLAUDE.md also pulls
// in with @import is inlined as raw text on every session, and inlined text
// carries no gate: the frontmatter would be printed into the context instead of
// filtering anything. Suggesting it would promise a saving that cannot happen,
// so such a rule never reaches the candidate list in the first place.
export function findConditionalCandidates(measured) {
  const candidates = [];
  const imported = measured.importedPaths ?? new Set();
  for (const rule of measured.alwaysLoadedRules) {
    if (imported.has(path.resolve(rule.path))) continue;
    const hit = monothematicHit(rule.content);
    if (!hit) continue;
    candidates.push({
      file: `rules/${rule.name}`,
      category: hit.cat.label,
      hits: hit.count,
      density: Number((hit.density * 100).toFixed(2)),
      words: hit.words,
      suggestedPaths: hit.cat.suggestedPaths,
    });
  }
  return candidates;
}

// Same detection, different remedy, hence a separate list. A file pulled in by
// @import does NOT obey a paths: frontmatter -- writing one there would look
// like a fix, change nothing, and cost the user the trust in the tool. The
// only way to take an imported file out of the always-loaded budget is to
// delete its @import line from CLAUDE.md and cite it as an on-demand
// reference instead; the file stays on disk and is read when the trigger
// named in CLAUDE.md happens.
export function findImportDemotionCandidates(measured) {
  const candidates = [];
  for (const doc of measured.importedDocs ?? []) {
    const hit = monothematicHit(doc.content);
    if (!hit) continue;
    candidates.push({
      file: `@${doc.rel}`,
      importedBy: doc.citedIn,
      category: hit.cat.label,
      hits: hit.count,
      density: Number((hit.density * 100).toFixed(2)),
      words: hit.words,
      bytes: doc.bytes,
      action: 'remove-import',
    });
  }
  return candidates;
}
