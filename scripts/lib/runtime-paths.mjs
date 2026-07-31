// runtime-paths.mjs
// Tells "the user's own configuration" apart from "Claude Code's runtime data"
// inside a config directory.
//
// Why this exists: migrate-models.mjs rewrites model ID strings. Pointed at a
// config directory with --dir it used to walk the whole tree -- 6,364 files on
// the machine this was found on -- which sweeps in the global .claude.json,
// the statistics caches, and the session transcripts under projects/. Those are
// not configuration. A transcript records which model actually ran a session
// that already happened; rewriting it does not migrate anything, it falsifies a
// historical record, and it does so under a flag whose whole promise is that it
// only touches config. The dry-run then closed by inviting --apply without a
// word about any of it.
//
// So inside a config directory these paths are skipped by default, and
// --include-runtime is there for the rare caller who really means it.
//
// Outside a config directory nothing changes: --dir on an ordinary project
// keeps scanning the full tree, which is the correct behaviour there.

import path from 'node:path';

// Top-level directories under a config root that hold runtime state, not
// configuration. Matched on the FIRST path segment only, so a project of the
// user's own that happens to contain a folder called "sessions" is unaffected.
const RUNTIME_DIRS = new Set([
  'projects',        // session transcripts: history, not config
  'jobs',
  'session-env',
  'telemetry',
  'sessions',
  'shell-snapshots',
  'statsig',
  'file-history',
  'paste-cache',
  'cache',
]);

// Runtime files sitting at the config root.
const RUNTIME_FILES = new Set([
  '.claude.json',      // global runtime config: model per project, history, MCP state
  '.claude.json.backup',
  'history.jsonl',
]);

// Statistics and status caches: *-cache.json, *.cache.json, plain cache.json.
const CACHE_FILE_RE = /(^|[-.])cache\.json$/i;

// Walks up from `startDir` looking for the config root that owns it. Two
// signals, both deliberate:
//   - a directory literally named `.claude` (the overwhelmingly common case,
//     global or per-project);
//   - the config directory this run resolved to, which covers a
//     CLAUDE_CODE_CONFIG_DIR pointing somewhere with another name.
//
// Deliberately NOT a signal: the presence of ~/.claude.json in a parent. That
// file lives in the home directory, so testing for it would classify every
// project under $HOME as "inside a config dir" and start skipping folders in
// ordinary repositories.
export function findConfigRoot(startDir, configDir = null) {
  const target = configDir ? path.resolve(configDir) : null;
  let dir = path.resolve(startDir);
  for (;;) {
    if (path.basename(dir) === '.claude') return dir;
    if (target && dir === target) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// True when `absPath` is runtime data belonging to `configRoot`.
export function isRuntimePath(absPath, configRoot) {
  const rel = path.relative(configRoot, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside the config root
  const parts = rel.split(/[\\/]/);
  if (parts.length > 1 && RUNTIME_DIRS.has(parts[0])) return true;
  const base = parts[parts.length - 1];
  return RUNTIME_FILES.has(base) || CACHE_FILE_RE.test(base);
}

// Convenience for a scan root: returns a predicate, or null when the root is
// not inside a config directory and the full scan is the right behaviour.
export function runtimeFilterFor(root, configDir = null) {
  const configRoot = findConfigRoot(root, configDir);
  if (!configRoot) return null;
  return (absPath) => isRuntimePath(absPath, configRoot);
}

export const RUNTIME_DIR_NAMES = [...RUNTIME_DIRS];
