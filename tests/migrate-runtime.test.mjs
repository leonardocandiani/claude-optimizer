// migrate-runtime.test.mjs
// migrate-models.mjs rewrites model ID strings. Inside a config directory it
// must not treat runtime data as configuration: .claude.json, the statistics
// caches and the session transcripts under projects/ record what already
// happened. Rewriting them is not a migration, it is editing history, and the
// dry-run used to invite --apply without mentioning any of it.
//
// The opposite mistake is just as real, so it is tested too: --dir on an
// ordinary project must still scan the whole tree, including folders that
// happen to be named "projects" or "cache".
//
// And the skip has a failure mode of its own, guarded at the end of this file:
// when it eats EVERY file, the run reads nothing, and a report that still
// closes with "no outdated model IDs found" is signing off on a scan that
// never happened.

import { createSuite, scratchDir, runScript } from './lib/harness.mjs';

const s = createSuite('migrate-runtime');
const tmp = scratchDir('migrate');

const OUTDATED = 'model: claude-opus-4-6 is the one to migrate\n';

// runScript throws when the script exits non-zero, which is now a legitimate
// outcome: "nothing was scanned" is reported as exit 2 so a caller driving
// this from a script can tell "no answer" apart from "all clear".
function runAllowingFailure(args) {
  try {
    return { out: runScript('migrate-models.mjs', args), status: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? ''), status: e.status ?? 1 };
  }
}

try {
  s.heading('Inside a .claude directory, runtime paths are skipped by default');
  {
    // Named `.claude` because that is how the tool recognises a config root.
    const dir = tmp.mkdir('fake/.claude');
    tmp.write('fake/.claude/CLAUDE.md', OUTDATED);
    tmp.write('fake/.claude/settings.json', `{"model": "claude-opus-4-6"}\n`);
    tmp.write('fake/.claude/.claude.json', `{"lastModel": "claude-opus-4-6"}\n`);
    tmp.write('fake/.claude/stats-cache.json', `{"model": "claude-opus-4-6"}\n`);
    tmp.write('fake/.claude/projects/session-1.md', OUTDATED);
    tmp.write('fake/.claude/shell-snapshots/snap.sh', OUTDATED);
    tmp.write('fake/.claude/telemetry/t.json', `{"m": "claude-opus-4-6"}\n`);
    tmp.write('fake/.claude/rules/modelo.md', OUTDATED);

    const out = runScript('migrate-models.mjs', ['--dir', dir]);
    const j = JSON.parse(runScript('migrate-models.mjs', ['--dir', dir, '--json']));
    const targets = j.findings.map((f) => f.file.replace(/\\/g, '/'));

    s.equal(j.filesSkippedRuntime, 5, 'five runtime files skipped');
    s.equal(j.filesScanned, 3, 'three real config files scanned');
    s.ok(!targets.some((f) => f.endsWith('/.claude.json')), '.claude.json is not a target');
    s.ok(!targets.some((f) => f.includes('/projects/')), 'session transcripts are not targets');
    s.ok(!targets.some((f) => f.includes('stats-cache')), 'the statistics cache is not a target');
    s.ok(targets.some((f) => f.endsWith('/CLAUDE.md')), 'CLAUDE.md is still a target');
    s.ok(targets.some((f) => f.endsWith('/rules/modelo.md')), 'rules/ is still a target');
    s.ok(targets.some((f) => f.endsWith('/settings.json')), 'settings.json is still a target');

    s.heading('And the skip is announced before the --apply invitation');
    const skipAt = out.indexOf('Files skipped as runtime data');
    const inviteAt = out.indexOf('Re-run with --apply');
    s.ok(skipAt !== -1, 'the report says how many files were skipped');
    s.ok(inviteAt !== -1 && skipAt < inviteAt, 'the warning comes before the invitation to write');
  }

  s.heading('--include-runtime brings them back');
  {
    const dir = tmp.join('fake/.claude');
    const j = JSON.parse(runScript('migrate-models.mjs', ['--dir', dir, '--json', '--include-runtime']));
    const targets = j.findings.map((f) => f.file.replace(/\\/g, '/'));
    s.equal(j.filesSkippedRuntime, 0, 'nothing is skipped');
    s.equal(j.filesScanned, 8, 'the whole tree is scanned');
    s.ok(targets.some((f) => f.endsWith('/.claude.json')), '.claude.json is scanned when asked for');
  }

  s.heading('An ordinary project is scanned in full, as before');
  {
    // Same folder names, no .claude anywhere: these are the project's own
    // directories and skipping them would be a bug of its own.
    const dir = tmp.mkdir('projeto-comum');
    tmp.write('projeto-comum/README.md', OUTDATED);
    tmp.write('projeto-comum/projects/a.md', OUTDATED);
    tmp.write('projeto-comum/cache/b.md', OUTDATED);
    tmp.write('projeto-comum/src/stats-cache.json', `{"m": "claude-opus-4-6"}\n`);

    const j = JSON.parse(runScript('migrate-models.mjs', ['--dir', dir, '--json']));
    s.equal(j.filesSkippedRuntime, 0, 'nothing is skipped outside a config directory');
    s.equal(j.filesScanned, 4, 'every file is scanned');
    s.equal(j.findings.length, 4, 'and every one of them is reported');
  }

  s.heading('Still a dry-run: --apply is required to write');
  {
    const dir = tmp.join('projeto-comum');
    const before = tmp.read('projeto-comum/README.md');
    runScript('migrate-models.mjs', ['--dir', dir]);
    s.equal(tmp.read('projeto-comum/README.md'), before, 'the file is unchanged after a dry-run');
  }

  // The clean bill of health used to be printed whenever findings were empty,
  // and "empty" is also what a scan that read nothing looks like. The file
  // count was already on screen, buried in the header, contradicted by the
  // conclusion right below it -- and the conclusion is the line people read.
  s.heading('A scan that read nothing does not report a clean result');
  {
    // Every file here is runtime data, so the skip eats the whole directory.
    const dir = tmp.mkdir('fake/.claude/projects/projeto-do-usuario');
    tmp.write('fake/.claude/projects/projeto-do-usuario/main.py', OUTDATED);
    tmp.write('fake/.claude/projects/projeto-do-usuario/setup.json', `{"model": "claude-opus-4-6"}\n`);

    const { out, status } = runAllowingFailure(['--dir', dir]);
    const j = JSON.parse(runAllowingFailure(['--dir', dir, '--json']).out);

    s.equal(j.filesScanned, 0, 'the scan really did read nothing');
    s.ok(!/No outdated or retired model IDs found/.test(out), 'it does not claim the files are clean');
    s.ok(/NOTHING WAS SCANNED/.test(out), 'it says out loud that nothing was scanned');
    s.ok(/--include-runtime/.test(out), 'and points at the way to scan them anyway');
    s.equal(status, 2, 'the exit code says "no answer" instead of "all clear"');

    s.heading('An empty directory gets the same treatment, with its own reason');
    const empty = tmp.mkdir('pasta-vazia');
    const emptyRun = runAllowingFailure(['--dir', empty]);
    s.ok(/NOTHING WAS SCANNED/.test(emptyRun.out), 'an empty path is not a clean result either');
    s.ok(/Check the --dir value/.test(emptyRun.out), 'and the reason given is the empty path, not the runtime skip');
    s.equal(emptyRun.status, 2, 'also exits non-zero');

    s.heading('A scan that did read files still answers normally');
    const ok = runAllowingFailure(['--dir', tmp.join('projeto-comum')]);
    s.equal(ok.status, 0, 'exit 0 when the scan actually happened');
    s.ok(!/NOTHING WAS SCANNED/.test(ok.out), 'and no false alarm');
  }
} finally {
  tmp.dispose();
}

const { failed } = s.finish();
process.exit(failed === 0 ? 0 : 1);
