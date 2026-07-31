// imports.mjs: resolve the @import graph of a CLAUDE.md.
//
// Claude Code lets a CLAUDE.md pull in other files with a bare `@path/to/file.md`
// line, and the official docs recommend splitting a large config that way. The
// pulled-in text is injected at launch and is read on every turn, exactly like
// the host file. Measuring only CLAUDE.md plus rules/ therefore under-reports a
// config in this format by however much the imports weigh, and it under-reports
// in the dangerous direction: the tool tells the user they are lean.
//
// Two properties matter for correctness here:
//   1. An `@` inside a fenced block, inline code, or an HTML comment is an
//      example, not an import. Treating it as one invents a phantom file and
//      then reports it as a dead pointer.
//   2. The graph can contain cycles (a imports b imports a). Track visited real
//      paths, and cap the depth so a pathological config cannot hang the tool.

import fs from 'node:fs';
import path from 'node:path';

const MAX_DEPTH = 5;

// Strips the regions where an @ cannot be an import, preserving line structure
// so anything downstream that cares about line numbers still lines up.
function stripNonImportRegions(text) {
  const blanked = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/```[\s\S]*?```/g, blanked)   // fenced code
    .replace(/~~~[\s\S]*?~~~/g, blanked)   // alternate fence
    .replace(/<!--[\s\S]*?-->/g, blanked)  // HTML comment
    .replace(/`[^`\n]*`/g, blanked);       // inline code
}

// An import line is a line whose only content is @<path>. Anything else on the
// line (prose, a list marker with text after) is not an import directive.
export function parseImportPaths(text) {
  const out = [];
  const cleaned = stripNonImportRegions(text ?? '');
  const lines = cleaned.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*@([^\s`]+)\s*$/.exec(lines[i]);
    if (m) out.push({ spec: m[1], line: i + 1 });
  }
  return out;
}

function resolveSpec(spec, fromFile, configDir) {
  if (spec.startsWith('~/')) return path.join(process.env.HOME ?? '', spec.slice(2));
  if (path.isAbsolute(spec)) return spec;
  // Relative to the importing file first, which is what Claude Code does, then
  // fall back to the config root so a top-level style path still resolves.
  const nextToImporter = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(nextToImporter)) return nextToImporter;
  return path.resolve(configDir, spec);
}

// Walks the graph from an entry file. Returns every file reachable through
// @import (resolved, deduped, cycle-safe) plus the imports that point nowhere.
export function resolveImports(entryPath, entryContent, configDir) {
  const imported = [];
  const missing = [];
  const seen = new Set([path.resolve(entryPath)]);

  const visit = (filePath, content, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const { spec, line } of parseImportPaths(content)) {
      const target = resolveSpec(spec, filePath, configDir);
      const real = path.resolve(target);
      if (seen.has(real)) continue;
      seen.add(real);
      if (!fs.existsSync(real)) {
        missing.push({ spec, from: filePath, line });
        continue;
      }
      let text = '';
      try { text = fs.readFileSync(real, 'utf8'); } catch { continue; }
      imported.push({
        path: real,
        name: path.relative(configDir, real),
        spec,
        importedBy: filePath,
        bytes: Buffer.byteLength(text, 'utf8'),
        content: text,
      });
      visit(real, text, depth + 1);
    }
  };

  visit(path.resolve(entryPath), entryContent ?? '', 0);
  return { imported, missing };
}

// `paths:` frontmatter only gates files that Claude Code loads FROM rules/.
// On an imported file the frontmatter is stripped before injection and the
// field is swallowed silently, so the file keeps loading on every turn while
// the author believes it is conditional. Verified experimentally by Robson
// Silveira Jr. with a 2x2 matrix (imported vs rules/, gating vs not) and a
// positive control proving the gate was live in the same run.
export function importedFilesClaimingPaths(imported) {
  return imported
    .filter((f) => /^---\s*[\s\S]*?^paths:/m.test(f.content))
    .map((f) => ({ name: f.name, importedBy: f.importedBy }));
}
