// fs-walk.mjs
// A small, dependency-free recursive file walker used by migrate-models.mjs
// to scan a project tree for outdated model IDs. Skips the usual noisy
// directories and anything that isn't a plausible text/source file.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'venv', '.venv', '__pycache__', '.cache', 'vendor', '.turbo',
  'coverage', 'target', '.archive', '_archive',
  '.pytest_cache', '.mypy_cache', '.tox',
]);

const DEFAULT_EXTENSIONS = new Set([
  '.md', '.mdx', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.json', '.yml', '.yaml', '.sh', '.txt',
  '.rb', '.go', '.java', '.kt', '.cs', '.php', '.rs',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB: skip anything that large, it is not a config or source file worth scanning

// Runtime data, not configuration. A Claude Code config directory also holds
// session transcripts, caches and telemetry; those record which model actually
// ran on a past session. Rewriting a model ID in there is not a migration, it
// falsifies a historical record, and it is silent because nobody reads those
// files by hand. Skipped by default, opt back in with --include-runtime.
const RUNTIME_DIRS = new Set([
  'projects', 'sessions', 'todos', 'statsig', 'telemetry', 'logs',
  'shell-snapshots', 'session-env', 'ide', 'file-history', 'history',
  'plugins', 'skills_archive', 'tmp',
]);
const RUNTIME_FILES = new Set([
  '.claude.json', 'history.jsonl', 'stats-cache.json', 'gh-pr-status-cache.json',
]);

export function isRuntimePath(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.some((seg) => RUNTIME_DIRS.has(seg))) return true;
  return RUNTIME_FILES.has(parts[parts.length - 1]);
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable directory (permissions, race with deletion): skip, do not crash the scan
  }
}

function fileSizeSafe(full) {
  try {
    return fs.statSync(full).size;
  } catch {
    return null;
  }
}

function isWalkableDir(entry, skipDirs) {
  return entry.isDirectory() && !skipDirs.has(entry.name);
}

function isScannableFile(entry, full, extensions) {
  if (!entry.isFile()) return false;
  const ext = path.extname(entry.name).toLowerCase();
  if (!extensions.has(ext)) return false;
  const size = fileSizeSafe(full);
  return size !== null && size <= MAX_FILE_BYTES;
}

// Yields absolute file paths under rootDir that pass the extension and size
// filters. Symlinks are never followed (avoids cycles).
export function* walkFiles(rootDir, opts = {}) {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const includeRuntime = opts.includeRuntime === true;
  const skipped = opts.skippedCounter;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readDirSafe(dir)) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (!includeRuntime && isRuntimePath(rel)) {
        if (skipped) skipped.count++;
        continue;
      }
      if (isWalkableDir(entry, skipDirs)) {
        stack.push(full);
      } else if (isScannableFile(entry, full, extensions)) {
        yield full;
      }
    }
  }
}
