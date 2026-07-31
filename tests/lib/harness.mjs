// harness.mjs
// The whole test framework: assertions, a scratch directory that cleans itself
// up, and a runner for a child script. Plain Node, no dependencies, no install
// step -- the same constraint the rest of the project holds itself to.
//
// Every test builds its OWN fixtures at run time inside its OWN directory under
// the system temp folder, and removes only that directory. Nothing here reads
// or writes a real Claude Code config, and nothing depends on a scratch folder
// somebody happened to leave behind.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS = path.join(PROJECT_ROOT, 'scripts');

export function createSuite(name) {
  const checks = [];
  let passed = 0;
  let failed = 0;

  const ok = (condition, message) => {
    if (condition) { passed++; console.log(`  PASS  ${message}`); }
    else { failed++; console.log(`  FAIL  ${message}`); }
    checks.push({ condition: !!condition, message });
    return !!condition;
  };

  // A failing assertion has to show the values; a passing one showing 400
  // characters of fixture buries the report it is meant to make readable.
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s !== undefined && s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  const equal = (actual, expected, message) =>
    ok(actual === expected, `${message} (got ${brief(actual)}, expected ${brief(expected)})`);

  return {
    ok,
    equal,
    heading: (text) => console.log(`\n${text}`),
    finish() {
      console.log('');
      console.log(`${name}: ${passed} passed, ${failed} failed`);
      return { passed, failed };
    },
  };
}

// A scratch directory of this test's own. `dispose` removes exactly the path it
// created and nothing else: no wildcards, no shared /tmp sweeping.
export function scratchDir(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `claude-optimizer-${label}-`));
  return {
    root,
    join: (...p) => path.join(root, ...p),
    write(relPath, content) {
      const full = path.join(root, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
      return full;
    },
    read: (relPath) => fs.readFileSync(path.join(root, relPath), 'utf8'),
    mkdir(relPath) {
      const full = path.join(root, relPath);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function runScript(script, args, opts = {}) {
  return execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A stray CLAUDE_OPTIMIZER_LANG or LANG in the developer's shell would
    // otherwise decide which language the report comes out in, and a test that
    // depends on the machine it runs on is not a test.
    env: { ...process.env, CLAUDE_OPTIMIZER_LANG: '', LANG: 'C', LC_ALL: 'C', ...(opts.env ?? {}) },
  });
}

export function auditJson(configDir, extraArgs = []) {
  return JSON.parse(runScript('audit.mjs', ['--dir', configDir, '--json', ...extraArgs]));
}

export const bytes = (s) => Buffer.byteLength(s, 'utf8');
