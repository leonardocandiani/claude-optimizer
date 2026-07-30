// config-dir.mjs
// Resolves which directory a script should treat as the Claude Code config
// root. Works for the global config (~/.claude) and for a project config
// (pass --dir explicitly, e.g. --dir ./my-project/.claude or --dir . if the
// project keeps CLAUDE.md and rules/ at its own root).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Subpaths that make up "the user's own config" inside a Claude Code config
// directory. Deliberately excludes runtime/cache data (session-env, projects,
// history.jsonl, telemetry, ...) and the bundled skills/ library: skills
// often ship their own migration-guide documentation that intentionally
// mentions retired model IDs as examples, which is not something to "fix".
const CONFIG_SUBPATHS = [
  'CLAUDE.md', 'rules', 'references', 'commands', 'agents',
  'hooks', 'context', 'output-styles', 'settings.json', 'settings.local.json',
];

export function resolveConfigDir(argv = process.argv.slice(2)) {
  const idx = argv.indexOf('--dir');
  if (idx !== -1 && argv[idx + 1]) {
    return path.resolve(argv[idx + 1]);
  }
  if (process.env.CLAUDE_CODE_CONFIG_DIR) {
    return path.resolve(process.env.CLAUDE_CODE_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.claude');
}

// The default scan surface for migrate-models.mjs when no --dir is given:
// only the paths that make up the user's own config, not the entire
// ~/.claude runtime data directory (which can hold tens of thousands of
// session/cache files). Explicit --dir flags bypass this and scan whatever
// the user pointed at, in full.
export function defaultConfigScanRoots(configDir) {
  return CONFIG_SUBPATHS
    .map((p) => path.join(configDir, p))
    .filter((p) => fs.existsSync(p));
}

export function hasFlag(argv, name) {
  return argv.includes(name);
}

export function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}
