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
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readDirSafe(dir)) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (isWalkableDir(entry, skipDirs)) {
        stack.push(full);
      } else if (isScannableFile(entry, full, extensions)) {
        yield full;
      }
    }
  }
}
