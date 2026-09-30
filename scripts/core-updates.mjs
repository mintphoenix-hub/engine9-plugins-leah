#!/usr/bin/env node
/*
  Notices a new engine9 core, tests every plugin against it, and says what happened.

    node scripts/core-updates.mjs [--report report.md] [--status status.json] [--dry]

  Core publishes no releases, so "a new release" is a new commit on its main branch. `core-tested.json` records the
  commit this package was last tested against. When core has moved, this
    1. installs the newest core and interfaces (package.json asks for core straight from its repository),
    2. runs every test, including core.test.mjs, which installs each plugin with core's own PluginWorker,
    3. if they pass: records the new commit in core-tested.json and bumps the patch version,
    4. writes a report and a small status file for .github/workflows/core-updates.yml, which opens a pull request
       (passed) or updates the core-compat issue (failed).
  It never tags, publishes or touches a site: a person merges the pull request and tags the release
  (AGENTS.md, "Changing the plugin"). --dry only says whether core has moved.
*/
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const CORE_REPO = 'https://github.com/engine9-ai/core.git';

/* First 40-hex sha in `git ls-remote` output. */
export const firstSha = (out) => (/\b([0-9a-f]{40})\b/.exec(String(out)) || [])[1] || null;

/* 3.7.0 -> 3.7.1. Only patch: a compatibility bump changes no published table, setting or export. */
export function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`not a plain version: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/* The commit npm really installed for a package, read from the lockfile it just wrote. This is what was tested; the
   commit `git ls-remote` shows a moment earlier may already be newer. */
export function resolvedSha(lock, name) {
  const r = lock?.packages?.[`node_modules/${name}`]?.resolved || '';
  return (/#([0-9a-f]{40})$/.exec(r) || [])[1] || null;
}

/* What to do, given the commit last tested and the newest one. */
export function decide({ recorded, newest }) {
  if (!newest) return { action: 'unknown', why: 'Could not read the newest core commit.' };
  if (!recorded) return { action: 'test', why: 'No core commit has been recorded yet.' };
  return recorded === newest ? { action: 'none', why: 'Core has not moved since it was last tested.' } : { action: 'test', why: 'Core has a new commit.' };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const status = (o) => { if (value('--status')) writeFileSync(value('--status'), JSON.stringify(o)); };
  const report = (t) => { if (value('--report')) writeFileSync(value('--report'), t); console.log(t); };

  const tested = JSON.parse(readFileSync('core-tested.json', 'utf8'));
  const newest = firstSha(run('git', ['ls-remote', CORE_REPO, 'HEAD']).stdout);
  const d = decide({ recorded: tested.core, newest });
  if (d.action !== 'test' || args.includes('--dry')) {
    status({ changed: false, action: d.action, core: newest, previous: tested.core });
    report(`${d.why}${args.includes('--dry') && d.action === 'test' ? ' (dry run: nothing was installed)' : ''}`);
    process.exit(d.action === 'unknown' ? 1 : 0);
  }

  // A lockfile would pin an old core, and testing that would tell us nothing about the newest one.
  if (existsSync('package-lock.json')) rmSync('package-lock.json');
  const install = run('npm', ['install', '--no-audit', '--no-fund']);
  if (install.status !== 0) {
    status({ changed: true, passed: false, core: newest, previous: tested.core, stage: 'install' });
    report(`Core moved to ${newest.slice(0, 7)} but \`npm install\` failed:\n\n\`\`\`\n${(install.stderr || install.stdout).slice(-1500)}\n\`\`\``);
    process.exit(0);
  }
  const version = JSON.parse(readFileSync('node_modules/@engine9/core/package.json', 'utf8')).version;
  const installed = resolvedSha(existsSync('package-lock.json') ? JSON.parse(readFileSync('package-lock.json', 'utf8')) : null, '@engine9/core') || newest;
  const test = run('npm', ['test']);
  const passed = test.status === 0;
  const tail = (test.stdout + test.stderr).split('\n').filter((l) => /FAIL|fail|Error|passed/.test(l)).slice(-25).join('\n');

  if (passed) {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const next = bumpPatch(pkg.version);
    pkg.version = next;
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync('core-tested.json', JSON.stringify({ core: installed, coreVersion: version, testedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
    status({ changed: true, passed: true, core: installed, coreVersion: version, previous: tested.core, version: next });
    report(`Every test passes against engine9 core ${version} (${installed.slice(0, 7)}), up from ${tested.core.slice(0, 7)}.\n\n` +
      `This records the tested commit in \`core-tested.json\` and bumps the package to ${next}. Nothing else changed: no table, setting or export.\n` +
      `After merging, tag the release \`v${next}\` so sites pick it up through their weekly update.\n\n\`\`\`\n${tail}\n\`\`\``);
  } else {
    status({ changed: true, passed: false, core: installed, coreVersion: version, previous: tested.core, stage: 'test' });
    report(`The newest engine9 core (${version}, ${installed.slice(0, 7)}) breaks a test.\n\nLast good commit: ${tested.core.slice(0, 7)}.\n\n\`\`\`\n${tail}\n\`\`\`\n\nFix the plugin, or pin core until it is fixed. Sites are not affected until they update.`);
  }
}
